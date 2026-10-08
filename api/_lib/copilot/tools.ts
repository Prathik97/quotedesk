// The co-pilot's tools. The model edits the structured RFx only through these seven. Each one
// validates its input with zod, applies a pure operation from engine/rfx.ts and answers with a
// short result. None of them reads vendor text or touches any seeded table.
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { PassRule } from '../../../engine/questionnaire.js';
import {
  addLines, addQuestions, removeLine, setKnockout, setTerms, updateLine, validateRfx,
  type DraftRfx, type OpResult, type Validation,
} from '../../../engine/rfx.js';

export const MAX_TOOL_CALLS_PER_TURN = 6;

const str = (max: number) => z.string().trim().max(max);
const uomText = str(40);
const qty = z.number().finite().positive().max(1e9);

const PassRuleInput = z
  .discriminatedUnion('op', [
    z.object({ op: z.literal('eq'), value: z.union([z.boolean(), z.number(), str(60)]) }),
    z.object({ op: z.literal('lte'), value: z.number().finite() }),
    z.object({ op: z.literal('gte'), value: z.number().finite() }),
    z.object({ op: z.literal('valid_on_date') }),
  ])
  .transform((r): PassRule => (r.op === 'valid_on_date' ? { op: 'valid_on_date', field: 'expiry', date: 'submission' } : r));

const LineItem = z.object({
  section: str(80).min(1),
  description: str(300).min(1),
  spec: str(300).nullish(),
  uom: uomText.nullish(),
  pack_size: z.number().finite().positive().max(1e6).nullish(),
  annual_qty: qty.nullish(),
});

const QuestionItem = z.object({
  text: str(300).min(1),
  answer_type: z.enum(['bool', 'number', 'date', 'text', 'choice']).default('text'),
  is_knockout: z.boolean().default(false),
  pass_rule: PassRuleInput.nullish(),
});

const days = z.number().int().min(0).max(730);

export const InputSchemas = {
  add_line_item: z.object({ items: z.array(LineItem).min(1).max(40) }),
  update_line_item: z.object({
    code: str(20).min(1),
    section: str(80).optional(),
    description: str(300).optional(),
    spec: str(300).nullish(),
    uom: uomText.nullish(),
    pack_size: z.number().finite().positive().max(1e6).nullish(),
    annual_qty: qty.nullish(),
  }),
  remove_line_item: z.object({ code: str(20).min(1) }),
  set_terms: z.object({
    title: str(150).optional(),
    scope_summary: str(1200).optional(),
    delivery_location: str(200).optional(),
    payment_terms_days: days.optional(),
    validity_days: days.optional(),
    gst_basis: z.enum(['excl_gst', 'incl_gst']).optional(),
    currency: z.enum(['INR', 'USD']).optional(),
    clarifications_by_day: days.optional(),
    quotes_due_day: days.optional(),
    award_by_day: days.optional(),
  }),
  add_question: z.object({ questions: z.array(QuestionItem).min(1).max(20) }),
  set_knockout: z.object({ code: str(20).min(1), is_knockout: z.boolean(), pass_rule: PassRuleInput.nullish() }),
  validate_rfx: z.object({}),
} as const;

export type ToolName = keyof typeof InputSchemas;
export const TOOL_NAMES = Object.keys(InputSchemas) as ToolName[];

const passRuleSchema = {
  type: 'object',
  description: 'How a vendor passes. {"op":"eq","value":true} must be yes; {"op":"lte","value":2} at most 2; {"op":"gte","value":5} at least 5; {"op":"valid_on_date"} certificate valid on the reply date.',
  properties: { op: { type: 'string', enum: ['eq', 'lte', 'gte', 'valid_on_date'] }, value: { type: ['boolean', 'number', 'string'] } },
  required: ['op'],
};

const lineItemSchema = {
  type: 'object',
  properties: {
    section: { type: 'string', description: 'Section heading, such as Cartons or Tapes and films.' },
    description: { type: 'string', description: 'What is being bought, with dimensions where they matter.' },
    spec: { type: ['string', 'null'], description: 'Material or quality spec, such as BF 22 or 23 micron.' },
    uom: { type: ['string', 'null'], description: 'Base unit to price per: piece, kg, sq m, roll, set, plate or pallet.' },
    pack_size: { type: ['number', 'null'], description: 'Only for pack units such as box: how many base units one pack holds.' },
    annual_qty: { type: ['number', 'null'], description: 'Annual quantity in the base unit. A proposal unless the buyer gave it.' },
  },
  required: ['section', 'description', 'uom', 'annual_qty'],
};

/** Tool list for the API. The last tool carries a cache breakpoint (added by the agent loop). */
export function toolDefinitions(): Anthropic.Tool[] {
  return [
    { name: 'add_line_item', description: 'Add line items to the RFx. Send every line you want to add in ONE call. Codes are assigned for you.', input_schema: { type: 'object', properties: { items: { type: 'array', items: lineItemSchema, minItems: 1, maxItems: 40 } }, required: ['items'] } },
    {
      name: 'update_line_item',
      description: 'Change fields of one line by its code. Only the fields you send change; send null to clear spec, uom, pack_size or annual_qty.',
      input_schema: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          section: { type: 'string' }, description: { type: 'string' }, spec: { type: ['string', 'null'] }, uom: { type: ['string', 'null'] },
          pack_size: { type: ['number', 'null'] }, annual_qty: { type: ['number', 'null'] },
        },
        required: ['code'],
      },
    },
    { name: 'remove_line_item', description: 'Remove one line by its code.', input_schema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } },
    {
      name: 'set_terms',
      description: 'Set the commercial terms, scope and timeline. Send only the fields that change. Timeline values are days after the RFx is issued.',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string' }, scope_summary: { type: 'string', description: 'Two or three sentences on what is being bought and why.' },
          delivery_location: { type: 'string' }, payment_terms_days: { type: 'integer' }, validity_days: { type: 'integer', description: 'How many days a quote must stay valid.' },
          gst_basis: { type: 'string', enum: ['excl_gst', 'incl_gst'] }, currency: { type: 'string', enum: ['INR', 'USD'] },
          clarifications_by_day: { type: 'integer' }, quotes_due_day: { type: 'integer' }, award_by_day: { type: 'integer' },
        },
      },
    },
    {
      name: 'add_question',
      description: 'Add questionnaire questions. Send every question in ONE call. Give knockouts a pass_rule.',
      input_schema: {
        type: 'object',
        properties: {
          questions: {
            type: 'array', minItems: 1, maxItems: 20,
            items: {
              type: 'object',
              properties: {
                text: { type: 'string' }, answer_type: { type: 'string', enum: ['bool', 'number', 'date', 'text', 'choice'] },
                is_knockout: { type: 'boolean' }, pass_rule: passRuleSchema,
              },
              required: ['text', 'answer_type'],
            },
          },
        },
        required: ['questions'],
      },
    },
    {
      name: 'set_knockout',
      description: 'Mark a question as a knockout or not, and set or change its pass rule.',
      input_schema: { type: 'object', properties: { code: { type: 'string' }, is_knockout: { type: 'boolean' }, pass_rule: passRuleSchema }, required: ['code', 'is_knockout'] },
    },
    { name: 'validate_rfx', description: 'Run the deterministic checks on the current RFx. Errors block Issue, warnings are allowed. Call it at the end of any turn that changed the RFx.', input_schema: { type: 'object', properties: {} } },
  ];
}

export type ToolOutcome = { rfx: DraftRfx; model: unknown; summary: string; error: boolean; validation: Validation | null };

const fail = (rfx: DraftRfx, message: string): ToolOutcome => ({ rfx, model: { error: message }, summary: message, error: true, validation: null });

function done(rfx: DraftRfx, r: OpResult, summary: string): ToolOutcome {
  if (r.error) return fail(rfx, r.error);
  return { rfx: r.rfx, model: r.result, summary, error: false, validation: null };
}

/** Runs one tool call against a draft. Pure: returns the new RFx and what to tell the model. */
export function runTool(rfx: DraftRfx, name: string, input: unknown): ToolOutcome {
  if (!(TOOL_NAMES as string[]).includes(name)) return fail(rfx, `Unknown tool ${name}.`);
  const schema = InputSchemas[name as ToolName];
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return fail(rfx, `Invalid input for ${name}: ${issue ? `${issue.path.join('.') || 'input'} ${issue.message}` : 'check the fields'}.`);
  }
  switch (name as ToolName) {
    case 'add_line_item': {
      const p = parsed.data as z.infer<typeof InputSchemas.add_line_item>;
      const r = addLines(rfx, p.items);
      return done(rfx, r, `Added ${r.result.added.length} ${r.result.added.length === 1 ? 'line' : 'lines'}${r.result.skipped.length ? `, skipped ${r.result.skipped.length}` : ''}`);
    }
    case 'update_line_item': {
      const { code, ...patch } = parsed.data as z.infer<typeof InputSchemas.update_line_item>;
      return done(rfx, updateLine(rfx, code, patch), `Updated ${code}`);
    }
    case 'remove_line_item': {
      const { code } = parsed.data as z.infer<typeof InputSchemas.remove_line_item>;
      return done(rfx, removeLine(rfx, code), `Removed ${code}`);
    }
    case 'set_terms': {
      const r = setTerms(rfx, parsed.data as z.infer<typeof InputSchemas.set_terms>);
      return done(rfx, r, `Set ${(r.result.changed as string[]).length} term ${(r.result.changed as string[]).length === 1 ? 'field' : 'fields'}`);
    }
    case 'add_question': {
      const p = parsed.data as z.infer<typeof InputSchemas.add_question>;
      const r = addQuestions(rfx, p.questions);
      return done(rfx, r, `Added ${r.result.added.length} ${r.result.added.length === 1 ? 'question' : 'questions'}`);
    }
    case 'set_knockout': {
      const p = parsed.data as z.infer<typeof InputSchemas.set_knockout>;
      return done(rfx, setKnockout(rfx, p.code, p.is_knockout, p.pass_rule), `${p.is_knockout ? 'Marked' : 'Unmarked'} ${p.code} as a knockout`);
    }
    case 'validate_rfx': {
      const v = validateRfx(rfx);
      return {
        rfx, validation: v, error: false,
        summary: v.errors === 0 ? `No errors, ${v.warnings} ${v.warnings === 1 ? 'warning' : 'warnings'}` : `${v.errors} ${v.errors === 1 ? 'error' : 'errors'} block Issue, ${v.warnings} ${v.warnings === 1 ? 'warning' : 'warnings'}`,
        model: { can_issue: v.can_issue, errors: v.errors, warnings: v.warnings, findings: v.findings.map((f) => ({ severity: f.severity, message: f.message })) },
      };
    }
  }
}

export function describeStep(name: string): string {
  const labels: Record<string, string> = {
    add_line_item: 'Adding line items', update_line_item: 'Updating a line', remove_line_item: 'Removing a line', set_terms: 'Setting terms and timeline',
    add_question: 'Adding questions', set_knockout: 'Setting a knockout', validate_rfx: 'Checking the RFx',
  };
  return labels[name] ?? name;
}
