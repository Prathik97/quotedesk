// GET /api/health: is the function alive. Deliberately imports nothing heavy: no database, no
// config parsing. /api/ready checks configuration and the database and says which layer fails.
import { route } from '../http.js';

export default route(['GET'], async () => ({ ok: true, time: new Date().toISOString() }));
