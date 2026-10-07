// GET /api/compare: everything the comparison workspace shows, from the views.
import { loadCompare } from '../compare/data.js';
import { db } from '../db.js';
import { route } from '../http.js';

export default route(['GET'], async () => loadCompare(db()));
