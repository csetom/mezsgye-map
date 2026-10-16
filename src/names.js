/**
 * Mezsgye Atlas — procedural naming.
 *
 * Hungarian-flavoured name parts, so generated maps sound like they belong in
 * the same setting as the word "mezsgye" itself. Pure ESM, shared by server and
 * browser. All functions take an `rng` (see `makeRng` in model.js) so output is
 * reproducible from a seed.
 */

/** Roots evoking void, weather, light and old land-words. */
export const ROOTS = [
  'Köd', 'Szél', 'Fény', 'Éj', 'Hold', 'Hamu', 'Vas', 'Só', 'Vér', 'Csend',
  'Árny', 'Zúg', 'Rév', 'Dél', 'Észak', 'Tűz', 'Jég', 'Füst', 'Mély', 'Üveg',
  'Kő', 'Ág', 'Gyökér', 'Hárs', 'Nyár', 'Tél', 'Hajnal', 'Alkony', 'Villám',
  'Zsálya', 'Borostyán', 'Szurok', 'Pernye', 'Örvény', 'Zátony', 'Vihar',
];

/** Place-suffixes: ford, mound, corner, keep, gate, bank, bridge, ditch. */
export const PLACE_SUFFIXES = [
  'rév', 'halom', 'szeg', 'vár', 'kapu', 'part', 'híd', 'árok', 'mező',
  'völgy', 'orom', 'köz', 'kút', 'tanya', 'zug', 'hát', 'fok', 'gát',
];

/** Suffixes for currents and streets. */
export const STREET_SUFFIXES = [
  'út', 'ág', 'sodrás', 'ér', 'folyam', 'csapás', 'nyom', 'vonal', 'járat',
];

/** Adjectives for prefixing. */
export const EPITHETS = [
  'Vén', 'Néma', 'Törött', 'Vak', 'Szent', 'Átkozott', 'Rejtett', 'Hideg',
  'Fakó', 'Zsibbadt', 'Égett', 'Elsüllyedt', 'Felső', 'Alsó', 'Belső', 'Külső',
];

/** Roman-ish numerals for world designations. */
const NUMERALS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];

function pickFrom(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

/**
 * Create a name generator that avoids repeating itself.
 *
 * @param {() => number} rng
 * @returns {{sector: () => string, world: (parent?: string, index?: number) => string,
 *            street: () => string, station: () => string, anomaly: () => string,
 *            reset: () => void}}
 */
export function createNamer(rng) {
  const used = new Set();

  /** Try `make` up to 40 times for an unused result, then accept a duplicate. */
  function unique(make) {
    for (let i = 0; i < 40; i += 1) {
      const candidate = make();
      if (!used.has(candidate)) {
        used.add(candidate);
        return candidate;
      }
    }
    const fallback = `${make()} ${pickFrom(rng, NUMERALS)}`;
    used.add(fallback);
    return fallback;
  }

  function compound() {
    const root = pickFrom(rng, ROOTS);
    const suffix = pickFrom(rng, PLACE_SUFFIXES);
    return `${root}${suffix}`;
  }

  return {
    /** e.g. "Ködrév", "Vén Hamuhalom" */
    sector() {
      return unique(() => (rng() < 0.25
        ? `${pickFrom(rng, EPITHETS)} ${compound()}`
        : compound()));
    },

    /** e.g. "Ködrév II", "Vén Hamu", "Zsályahalom" */
    world(parentName, index) {
      return unique(() => {
        const roll = rng();
        if (parentName && roll < 0.45) {
          const numeral = NUMERALS[Math.min(index ?? 0, NUMERALS.length - 1)];
          return `${parentName} ${numeral}`;
        }
        if (roll < 0.7) return `${pickFrom(rng, EPITHETS)} ${pickFrom(rng, ROOTS)}`;
        return compound();
      });
    },

    /** e.g. "Csendút", "Törött Vasfolyam" */
    street() {
      return unique(() => {
        const root = pickFrom(rng, ROOTS);
        const suffix = pickFrom(rng, STREET_SUFFIXES);
        return rng() < 0.3
          ? `${pickFrom(rng, EPITHETS)} ${root}${suffix}`
          : `${root}${suffix}`;
      });
    },

    /** e.g. "Sókapu állomás" */
    station() {
      return unique(() => `${compound()} állomás`);
    },

    /** e.g. "Örvény-anomália" */
    anomaly() {
      return unique(() => `${pickFrom(rng, ROOTS)}-anomália`);
    },

    island() {
      return unique(() => `${pickFrom(rng, ROOTS)}-sziget`);
    },
    reset() {
      used.clear();
    },
  };
}
