// GET /api/compare: everything the comparison workspace shows, from the views.
import { loadCompare } from './_lib/compare/data.js';
import { db } from './_lib/db.js';
import { route } from './_lib/http.js';

export default route(['GET'], async () => loadCompare(db()));
