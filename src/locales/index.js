import es from './es.js';
import fr from './fr.js';
import pt from './pt.js';
import de from './de.js';
import ru from './ru.js';
import sw from './sw.js';

// English is the base (copy.js). Each file here only overrides what it translates; the rest falls back to English.
export const LOCALES = { en: {}, es, fr, pt, de, ru, sw };
