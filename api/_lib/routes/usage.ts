// GET /api/usage: calls and estimated cost today, and whether the spend cap leaves room (FR-11.2).
import { db } from '../db.js';
import { usageSummary } from '../guard.js';
import { route } from '../http.js';

export default route(['GET'], async () => usageSummary(db()));
