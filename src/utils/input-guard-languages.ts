/**
 * INPUT GUARD, non-English packs — Portuguese and Spanish.
 *
 * The English guard (`input-guard.ts`) is unchanged and stays where it is. This
 * module adds one pack per language and answers the same narrow question: does
 * this line describe a sexual act with a minor, or a sexual act between family?
 *
 * Rules that shaped the lists (owner, 2026-11-25):
 *
 *  - PRECISION AND LENIENCY. A word that is innocent in one language must not be
 *    blocked because it is coarse in another. `son` is Spanish for "are"; `cu` is
 *    a common word; `coger`/`gozar` are everyday verbs in most of Latin America.
 *    A line a reader can take two ways is left clear.
 *  - BOTH SIGNALS FROM ONE PACK. A save in Portuguese is read by the Portuguese
 *    pack only. An English act word beside a Portuguese family word is not a
 *    verdict — it is two languages in one line, and not this guard's business.
 *  - WHOLE TOKENS. Never a substring: "irmandade" contains the letters of a
 *    family word and is not one.
 *  - ACCENTS ARE NOT FOLDED BLINDLY. Where dropping an accent would produce a
 *    different word (`pais` parents / `país` country, `ano` year / `año` Spanish
 *    year), both spellings are listed explicitly instead.
 *  - THE OWNER OF THE RELATIVE MUST BE THE ONE ACTING. "Minha esposa transou com
 *    meu irmão" is my wife and my brother, not the player with their own family.
 *    So every act carries a person (first, second, open) and only the possessive
 *    of that person makes the relative the actor's own.
 */

import { GUARD_CATEGORIES, GUARD_MESSAGES, type GuardCategory, type GuardVerdict } from './input-guard'

type Person = 'first' | 'second' | 'open'

interface Token {
  text: string
  /** Comma-separated clause. A family noun set off by a comma is address, not an object. */
  segment: number
}

interface ActMatch {
  start: number
  end: number
  segment: number
  person: Person
}

/** The complement slot of an act: what it is done to. */
interface ObjectRef {
  nounIndex: number
  article?: string
  possessive?: string
  own: boolean
}

interface ActPhrase {
  words: readonly string[]
  person: Person
}

interface Pack {
  /** Forms whose subject is I or we. */
  firstActs: ReadonlySet<string>
  /** Forms whose subject is you (tú/vos, tu, imperatives). */
  secondActs: ReadonlySet<string>
  /** Infinitives, gerunds, participles, nouns, third person and shared forms. */
  openActs: ReadonlySet<string>
  /** Participles that are only an act after a `ter` auxiliary ("tenho transado"). */
  terParticiples: ReadonlySet<string>
  terAux: ReadonlySet<string>
  actPhrases: readonly ActPhrase[]
  /** Idioms that contain an act spelling but mean something else. Blanked first. */
  idioms: readonly (readonly string[])[]
  family: ReadonlySet<string>
  firstPoss: ReadonlySet<string>
  secondPoss: ReadonlySet<string>
  /** Third-person possessives: family only under a Portuguese `você`. */
  thirdPoss: ReadonlySet<string>
  youMarkers: ReadonlySet<string>
  possessives: ReadonlySet<string>
  articles: ReadonlySet<string>
  connectors: ReadonlySet<string>
  own: ReadonlySet<string>
  /** Minor nouns that are unambiguous on their own. */
  minorAlways: ReadonlySet<string>
  /** Minor nouns that count only with a stated age beside them. */
  minorWithAge: ReadonlySet<string>
  /** Plural minor nouns that count only under a plural article. */
  pluralMinor: ReadonlySet<string>
  pluralArticles: ReadonlySet<string>
  definitePluralArticles: ReadonlySet<string>
  minorPhrases: readonly (readonly string[])[]
  ageUnits: ReadonlySet<string>
  ageVerbs: ReadonlySet<string>
  /** Age verbs that take a subject, so a relationship or thing before them is no age. */
  ageThirdPerson: ReadonlySet<string>
  ageWords: ReadonlyMap<string, number>
  /** What may follow the unit for the age to count at all. */
  ageFollows: ReadonlySet<string>
  ageOfMinor: string
  childPossessives: ReadonlySet<string>
  childNouns: ReadonlySet<string>
  /** Coded terms that exist for no other purpose. */
  coded: readonly (readonly string[])[]
  negators: ReadonlySet<string>
  codedNegators: ReadonlySet<string>
  markers: ReadonlySet<string>
  /** Multi-token markers: `a gente` takes the third-person form but is "we". */
  markerPhrases: readonly (readonly string[])[]
  /** Religious uses of a kin word, masked before matching. */
  titles: readonly RegExp[]
}

const set = (...words: string[]): ReadonlySet<string> => new Set(words)
const map = (entries: Array<[string, number]>): ReadonlyMap<string, number> => new Map(entries)

// ── shared vocabulary ────────────────────────────────────────────────────────

/**
 * Words that may sit between a first-person marker and the act it governs
 * ("eu quero muito transar"). Nothing else may: "ela contou que eu transei com
 * minha irmã" is a confession, not the player acting here.
 */
const LIGHT = set(
  'de', 'a', 'em', 'en', 'muito', 'mucho', 'tanto', 'mesmo', 'também', 'tambem', 'también', 'tambien',
  'hoje', 'hoy', 'sempre', 'siempre', 'me', 'ir', 'poder', 'tentar', 'intentar', 'voltar', 'volver',
  'começar', 'comecar', 'empezar', 'continuar', 'seguir', 'parar', 'deixar', 'dejar',
)

/** First-person markers: the speaker is the one who would be acting. */
const MARKERS = set(
  'eu', 'yo', 'nós', 'nosotros', 'nosotras',
  'quero', 'quiero', 'queria', 'quería', 'vou', 'voy', 'estou', 'tô', 'to', 'estoy',
  'posso', 'puedo', 'preciso', 'necesito', 'gosto', 'adoro', 'amo', 'fantasio', 'sonho', 'sueño', 'sueno',
  'penso', 'pienso', 'comecei', 'empecé', 'empece', 'fiz', 'faço', 'faco', 'fazíamos', 'faziamos', 'hice',
  'hago', 'tive', 'tenho', 'tuve', 'tengo', 'vamos', 'consigo',
)

/** A denial about the act itself. Per language: Portuguese `no` means "in the". */
const PT_NEGATORS = set('não', 'nao', 'nunca', 'jamais')
const ES_NEGATORS = set('no', 'nunca', 'jamás', 'jamas')

/** A stopper between the negation and the act means the desire survives it. */
const DENIAL_STOPPERS = set('parar', 'dejar', 'resistir', 'evitar', 'aguentar', 'aguantar')

/** Negators that clear one coded-term occurrence. */
const PT_CODED_NEGATORS = set('não', 'nao', 'nunca', 'ninguém', 'ninguem', 'nenhum', 'sem', 'deixou')
const ES_CODED_NEGATORS = set('no', 'nunca', 'nadie', 'ningún', 'ningun', 'sin', 'jamás', 'jamas')

/** "no me importa que sea menor de edad" — the clause turns the negation around. */
const CODED_BLOCKERS = set('que', 'se', 'si')

/** Someone else in the room, after the noun: the object is not alone with the act. */
const ELSEWHERE_ADJECTIVES = set(
  'dormidos', 'dormidas', 'dormido', 'dormida', 'acordados', 'acordadas', 'acordado', 'acordada',
  'despiertos', 'despiertas', 'despierto', 'despierta',
)
const ELSEWHERE_PHRASES = [
  ['em', 'casa'], ['en', 'casa'], ['ao', 'lado'], ['al', 'lado'], ['do', 'lado'],
  ['aqui', 'perto'], ['aquí', 'cerca'], ['aqui', 'cerca'],
] as const
/** The only three that clear a singular minor noun. */
const BESIDE_PHRASES = [['ao', 'lado'], ['al', 'lado'], ['do', 'lado']] as const

/**
 * A gerund after the object means someone else is around ("com as crianças
 * dormindo"). Only the two productive endings count, because plenty of ordinary
 * words end in `-ndo` without being a verb form.
 */
const GERUND = /(?:ando|endo|indo)$/
const NOT_GERUNDS = set(
  'quando', 'cuando', 'segundo', 'profundo', 'imundo', 'moribundo', 'vagabundo', 'rotundo', 'fecundo',
)

/** Talking about sex, not having it. */
const SPEECH_VERBS = set(
  'falar', 'falo', 'fala', 'falamos', 'falei', 'falou', 'falaram',
  'conversar', 'converso', 'conversa', 'conversamos', 'conversei', 'conversou',
  'discutir', 'discuto', 'discute', 'discutimos', 'discuti', 'discutiu',
  'perguntar', 'pergunto', 'pergunta', 'perguntamos', 'perguntei', 'perguntou',
  'saber', 'sei', 'sabe', 'sabemos', 'soube',
  'hablar', 'hablo', 'habla', 'hablamos', 'hablé', 'hablo', 'habló', 'hablaron',
  'charlar', 'charlo', 'charla', 'charlamos', 'charlé', 'charló',
  'discutimos', 'discutió', 'preguntar', 'pregunto', 'pregunta', 'preguntamos', 'pregunté', 'preguntó',
  'sé', 'sabe', 'sabemos', 'supe',
)

/** Pointing back at the possessed child, after the act. */
const CHILD_PRONOUNS = [
  ['com', 'ele'], ['com', 'ela'], ['con', 'él'], ['con', 'el'], ['con', 'ella'], ['comigo'], ['conmigo'],
] as const

/** A relationship or thing is what "tem 5 anos" counts when it is the subject. */
const THING_SUBJECTS = set(
  'namoro', 'casamento', 'noivado', 'relacionamento', 'relação', 'relacao', 'romance', 'amizade', 'história',
  'historia', 'matrimonio', 'relación', 'relacion', 'noviazgo', 'amistad', 'casa', 'apartamento', 'piso', 'bar',
)

const SHARED_CODED = [['loli'], ['lolicon'], ['shota'], ['shotacon']] as const

const MINOR_PHRASES = [
  ['menor', 'de', 'idade'],
  ['menores', 'de', 'idade'],
  ['menor', 'de', 'edad'],
  ['menores', 'de', 'edad'],
] as const

const AGE_FOLLOWS = ['e', 'y', 'pero', 'porém', 'porem', 'aunque', 'embora', 'porque', 'quero', 'quiero'] as const

// ── Portuguese ────────────────────────────────────────────────────────────────

const PT: Pack = {
  firstActs: set(
    // transar
    'transo', 'transamos', 'transei', 'transávamos', 'transavamos', 'transemos', 'transarei', 'transarmos',
    // foder
    'fodo', 'fodemos', 'fodi', 'fodíamos', 'fodiamos', 'foderei', 'fodermos',
    // masturbar(-se)
    'masturbo', 'masturbamos', 'masturbei', 'masturbemos', 'masturbo-me', 'masturbei-me',
    // ejacular
    'ejaculo', 'ejaculamos', 'ejaculei',
  ),
  secondActs: set(
    // transar
    'transas', 'transais', 'transaste', 'transavas', 'transares',
    // foder
    'fodes', 'fodeis', 'fodeste', 'fodias', 'foderes',
    // masturbar
    'masturbas', 'masturbais', 'masturbaste', 'masturbes',
    // ejacular
    'ejaculas',
  ),
  openActs: set(
    // transar — `transe`/`transes` are a trance, and `transado` needs a `ter`
    // auxiliary, so neither is an act on its own.
    'transar', 'transa', 'transam', 'transou', 'transaram', 'transava', 'transavam', 'transando',
    'transem', 'transasse', 'transassem', 'transarem', 'transará', 'transara', 'transariam',
    // foder — `fodeu`, `foderam` and `fode` are out: too often an exclamation.
    'foder', 'fodem', 'fodia', 'fodiam', 'fodendo', 'foderá', 'fodera', 'foderão', 'foderia',
    'foderiam', 'foderem', 'fodesse', 'fodessem',
    // masturbar(-se)
    'masturbar', 'masturba', 'masturbam', 'masturbou', 'masturbaram', 'masturbava', 'masturbavam',
    'masturbando', 'masturbado', 'masturbada', 'masturbados', 'masturbadas', 'masturbe', 'masturbem',
    'masturbar-se', 'masturbarse', 'masturbou-se', 'masturbando-se', 'masturbam-se',
    // unmistakable nouns
    'boquete', 'boquetes', 'siririca', 'siriricas', 'punheta', 'punhetas',
    'buceta', 'bucetas', 'boceta', 'bocetas', 'xoxota', 'xoxotas',
    'orgasmo', 'orgasmos', 'orgia', 'orgias', 'suruba', 'surubas',
    // ejacular
    'ejacular', 'ejacula', 'ejaculam', 'ejaculou', 'ejacularam', 'ejaculava', 'ejaculavam',
    'ejaculando', 'ejaculado', 'ejaculada', 'ejacule', 'ejaculem',
  ),
  terParticiples: set('transado', 'transada', 'transados', 'transadas'),
  terAux: set('tenho', 'tinha', 'tínhamos', 'tinhamos', 'tem', 'ter', 'havia', 'teria'),
  actPhrases: [
    { words: ['fazer', 'sexo'], person: 'open' },
    { words: ['faço', 'sexo'], person: 'first' }, { words: ['faco', 'sexo'], person: 'first' },
    { words: ['fazendo', 'sexo'], person: 'open' },
    { words: ['fez', 'sexo'], person: 'open' },
    { words: ['fiz', 'sexo'], person: 'first' }, { words: ['fizemos', 'sexo'], person: 'first' },
    { words: ['fazer', 'amor'], person: 'open' },
    { words: ['faço', 'amor'], person: 'first' }, { words: ['faco', 'amor'], person: 'first' },
    { words: ['fazendo', 'amor'], person: 'open' },
    { words: ['fez', 'amor'], person: 'open' },
    { words: ['fiz', 'amor'], person: 'first' }, { words: ['fizemos', 'amor'], person: 'first' },
    { words: ['sexo', 'com'], person: 'open' },
    { words: ['sexo', 'oral'], person: 'open' },
    { words: ['sexo', 'anal'], person: 'open' },
  ],
  idioms: [
    ['se', 'foder'], ['vai', 'se', 'foder'], ['vá', 'se', 'foder'], ['va', 'se', 'foder'],
    ['se', 'fodeu'], ['me', 'fodi'],
    ['vai', 'foder'], ['vá', 'foder'], ['va', 'foder'], ['vão', 'foder'], ['vao', 'foder'],
    ['vai', 'te', 'foder'], ['foder-se'], ['foderse'],
  ],
  family: set(
    'mãe', 'mães', 'mae', 'maes', 'pai', 'pais',
    'irmã', 'irmãs', 'irma', 'irmas', 'irmão', 'irmãos', 'irmao', 'irmaos',
    'filha', 'filhas', 'filho', 'filhos',
    'tia', 'tias', 'tio', 'tios',
    'sobrinha', 'sobrinhas', 'sobrinho', 'sobrinhos',
    'prima', 'primas', 'primo', 'primos',
    'avó', 'avô', 'avós', 'avo', 'avos',
    'madrasta', 'madrastas', 'padrasto', 'padrastos',
    'enteada', 'enteadas', 'enteado', 'enteados',
  ),
  firstPoss: set('meu', 'minha', 'meus', 'minhas', 'nosso', 'nossa', 'nossos', 'nossas'),
  secondPoss: set('teu', 'tua', 'teus', 'tuas'),
  thirdPoss: set('seu', 'sua', 'seus', 'suas', 'vosso', 'vossa', 'vossos', 'vossas'),
  youMarkers: set('você', 'voce'),
  possessives: set(
    'meu', 'minha', 'meus', 'minhas', 'nosso', 'nossa', 'nossos', 'nossas',
    'teu', 'tua', 'teus', 'tuas',
    'seu', 'sua', 'seus', 'suas', 'vosso', 'vossa', 'vossos', 'vossas',
  ),
  articles: set('o', 'a', 'os', 'as', 'um', 'uma', 'uns', 'umas'),
  connectors: set('com', 'a'),
  own: set('própria', 'propria', 'próprio', 'proprio', 'próprias', 'proprias', 'próprios', 'proprios'),
  minorAlways: set('criança', 'crianças', 'crianca', 'criancas', 'adolescente', 'adolescentes'),
  minorWithAge: set('menina', 'meninas', 'menino', 'meninos', 'garota', 'garotas', 'garoto', 'garotos'),
  pluralMinor: set(),
  pluralArticles: set('os', 'as', 'uns', 'umas'),
  definitePluralArticles: set('os', 'as'),
  minorPhrases: MINOR_PHRASES,
  ageUnits: set('ano', 'anos'),
  ageVerbs: set('tenho', 'tem', 'têm'),
  ageThirdPerson: set('tem', 'têm'),
  ageWords: map([
    ['um', 1], ['uma', 1], ['dois', 2], ['duas', 2], ['três', 3], ['tres', 3], ['quatro', 4],
    ['cinco', 5], ['seis', 6], ['sete', 7], ['oito', 8], ['nove', 9], ['dez', 10], ['onze', 11],
    ['doze', 12], ['treze', 13], ['catorze', 14], ['quatorze', 14], ['quinze', 15],
    ['dezesseis', 16], ['dezasseis', 16], ['dezessete', 17], ['dezassete', 17],
  ]),
  ageFollows: set(...AGE_FOLLOWS, 'mas'),
  ageOfMinor: 'idade',
  childPossessives: set('meu', 'minha', 'meus', 'minhas', 'nosso', 'nossa', 'nossos', 'nossas'),
  childNouns: set('filho', 'filha', 'filhos', 'filhas', 'bebê', 'bebe', 'sobrinho', 'sobrinha', 'sobrinhos', 'sobrinhas'),
  coded: [...SHARED_CODED, ...MINOR_PHRASES],
  negators: PT_NEGATORS,
  codedNegators: PT_CODED_NEGATORS,
  markers: MARKERS,
  markerPhrases: [['a', 'gente']],
  titles: [/\b(?:Irmão|Irmã|Frei|Frade|Madre|Sor)\s+[A-ZÁÉÍÓÚÂÊÔÃÕÇ][a-záéíóúâêôãõç]+/g],
}

// ── Spanish ───────────────────────────────────────────────────────────────────

const ES: Pack = {
  firstActs: set(
    // follar
    'follo', 'follamos', 'follé', 'folle', 'follábamos', 'follaremos', 'follaríamos', 'folláramos', 'follásemos',
    // clitics whose object is me/us
    'follarme', 'follarnos', 'follándome', 'follándonos', 'fóllame', 'follame', 'fóllanos',
    // masturbar(se)
    'masturbo', 'masturbamos', 'masturbé', 'masturbe', 'masturbarme', 'masturbarnos', 'masturbándome',
    // eyacular
    'eyaculo', 'eyaculamos', 'eyaculé',
  ),
  secondActs: set(
    // follar, tú and vosotros
    'follas', 'folláis', 'follaste', 'follabas', 'follasteis', 'follarás', 'follarías', 'folles', 'folléis',
    'follaras', 'follases', 'follad',
    // imperatives and clitics whose object is you
    'follarte', 'follándote', 'fóllate', 'follate',
    'folladme', 'folladle', 'folladla', 'folladlos', 'folladlas',
    // masturbar(se)
    'masturbas', 'masturbáis', 'masturbaste', 'mastúrbate', 'masturbate', 'masturbarte',
    'masturbándote', 'mastúrbese', 'masturbese',
    // eyacular
    'eyaculas',
  ),
  openActs: set(
    // follar
    'follar', 'folla', 'follan', 'folló', 'follaron', 'follaba', 'follabais', 'follaban', 'follará',
    'follarán', 'follaría', 'follarían', 'follen', 'follara', 'follaran', 'follase', 'follasen',
    'follando', 'follado', 'follada', 'follados', 'folladas',
    'follarlo', 'follarla', 'follaros', 'follarlos', 'follarlas', 'follármelo', 'follármela',
    'follándolo', 'follándola', 'follándose', 'fóllalo', 'follalo', 'fóllala', 'follala', 'fóllalos', 'fóllalas',
    // masturbar(se)
    'masturbar', 'masturba', 'masturban', 'masturbó', 'masturbaron', 'masturbaba', 'masturbaban',
    'masturbando', 'masturbado', 'masturbada', 'masturbados', 'masturbadas', 'masturben',
    'masturbarse', 'masturbarlo', 'masturbarla', 'masturbándose',
    // unmistakable nouns
    'orgasmo', 'orgasmos', 'orgía', 'orgías', 'orgia', 'orgias',
    // eyacular
    'eyacular', 'eyacula', 'eyaculan', 'eyaculó', 'eyacularon', 'eyaculaba', 'eyaculaban',
    'eyaculando', 'eyaculado', 'eyaculada', 'eyacule', 'eyaculen',
  ),
  terParticiples: set(),
  terAux: set(),
  actPhrases: [
    { words: ['tener', 'sexo'], person: 'open' },
    { words: ['tengo', 'sexo'], person: 'first' },
    { words: ['teniendo', 'sexo'], person: 'open' },
    { words: ['tuve', 'sexo'], person: 'first' }, { words: ['tuvimos', 'sexo'], person: 'first' },
    { words: ['tuvo', 'sexo'], person: 'open' },
    { words: ['hacer', 'el', 'amor'], person: 'open' },
    { words: ['hago', 'el', 'amor'], person: 'first' },
    { words: ['haciendo', 'el', 'amor'], person: 'open' },
    { words: ['hizo', 'el', 'amor'], person: 'open' },
    { words: ['hice', 'el', 'amor'], person: 'first' }, { words: ['hicimos', 'el', 'amor'], person: 'first' },
    { words: ['sexo', 'con'], person: 'open' },
    { words: ['sexo', 'oral'], person: 'open' },
    { words: ['sexo', 'anal'], person: 'open' },
  ],
  idioms: [],
  family: set(
    'madre', 'madres', 'padre', 'padres',
    'hermana', 'hermanas', 'hermano', 'hermanos',
    'hija', 'hijas', 'hijo', 'hijos',
    'tía', 'tías', 'tia', 'tias', 'tío', 'tíos', 'tio', 'tios',
    'sobrina', 'sobrinas', 'sobrino', 'sobrinos',
    'prima', 'primas', 'primo', 'primos',
    'abuela', 'abuelas', 'abuelo', 'abuelos',
    'madrastra', 'madrastras', 'padrastro', 'padrastros',
    'hijastra', 'hijastras', 'hijastro', 'hijastros',
    'hermanastra', 'hermanastras', 'hermanastro', 'hermanastros',
  ),
  firstPoss: set('mi', 'mis', 'nuestro', 'nuestra', 'nuestros', 'nuestras'),
  secondPoss: set('tu', 'tus'),
  thirdPoss: set('su', 'sus', 'vuestro', 'vuestra', 'vuestros', 'vuestras'),
  youMarkers: set(),
  possessives: set(
    'mi', 'mis', 'tu', 'tus', 'su', 'sus', 'nuestro', 'nuestra', 'nuestros', 'nuestras',
    'vuestro', 'vuestra', 'vuestros', 'vuestras',
  ),
  articles: set('el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas'),
  connectors: set('con', 'a'),
  own: set('propia', 'propio', 'propias', 'propios'),
  minorAlways: set('adolescente', 'adolescentes'),
  minorWithAge: set('niño', 'niña', 'nino', 'nina', 'chica', 'chico'),
  pluralMinor: set('niños', 'niñas', 'ninos', 'ninas'),
  pluralArticles: set('los', 'las', 'unos', 'unas'),
  definitePluralArticles: set('los', 'las'),
  minorPhrases: MINOR_PHRASES,
  ageUnits: set('año', 'años', 'ano', 'anos'),
  ageVerbs: set('tengo', 'tiene'),
  ageThirdPerson: set('tiene'),
  ageWords: map([
    ['un', 1], ['uno', 1], ['una', 1], ['dos', 2], ['tres', 3], ['cuatro', 4], ['cinco', 5],
    ['seis', 6], ['siete', 7], ['ocho', 8], ['nueve', 9], ['diez', 10], ['once', 11],
    ['doce', 12], ['trece', 13], ['catorce', 14], ['quince', 15], ['dieciséis', 16],
    ['dieciseis', 16], ['diecisiete', 17],
  ]),
  ageFollows: set(...AGE_FOLLOWS),
  ageOfMinor: 'edad',
  childPossessives: set('mi', 'mis', 'nuestro', 'nuestra', 'nuestros', 'nuestras'),
  childNouns: set('hijo', 'hija', 'hijos', 'hijas', 'bebé', 'bebe', 'sobrino', 'sobrina', 'sobrinos', 'sobrinas'),
  coded: [...SHARED_CODED, ...MINOR_PHRASES],
  negators: ES_NEGATORS,
  codedNegators: ES_CODED_NEGATORS,
  markers: MARKERS,
  markerPhrases: [],
  titles: [/\b(?:Padre|Madre|Hermano|Hermana|Sor)\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+/g],
}

const PACKS = new Map<string, Pack>([['pt', PT], ['es', ES]])

// ── text ──────────────────────────────────────────────────────────────────────

const TOKEN = /[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu
const ZERO_WIDTH = /[\u200b-\u200d\ufeff]/g
const QUOTES_AND_ASTERISKS = /["'“”„«»‘’*]/g
const MASK = '\u0000'

/**
 * Sentence scope: today's splitter plus the punctuation the packs need
 * (inverted marks and the ellipsis, which is a spoken sentence break).
 */
function splitSentences(text: string): string[] {
  return text.split(/[.!?;\n\r¿¡…]+/).filter((sentence) => sentence.trim().length > 0)
}

/**
 * `Loli` is a common adult name, so the capitalised spelling is a coded term only
 * under an indefinite article. The lowercase spelling exists for no other purpose
 * and always counts.
 */
function maskLoliName(text: string): string {
  return text.replace(/\bLoli\b/g, (word: string, offset: number, whole: string) => {
    const before = whole.slice(Math.max(0, offset - 6), offset)
    return /(?:^|\s)(?:un|una)\s+$/i.test(before) ? word : ' '
  })
}

function normalize(text: string, pack: Pack): string {
  // Titles are capitalised ("Padre Juan"), so mask them before lowercasing.
  let out = text.normalize('NFKC').replace(ZERO_WIDTH, '')
  out = maskLoliName(out)
  for (const title of pack.titles) out = out.replace(title, ' ')
  return out.toLowerCase().replace(QUOTES_AND_ASTERISKS, ' ').replace(/\s+/g, ' ')
}

/** Tokens with a comma-clause id, so a vocative cannot become an object. */
function tokenize(normalized: string): Token[] {
  const tokens: Token[] = []
  normalized.split(',').forEach((clause, segment) => {
    for (const match of clause.matchAll(TOKEN)) tokens.push({ text: match[0], segment })
  })
  return tokens
}

function isPhrase(tokens: Token[], start: number, phrase: readonly string[]): boolean {
  if (start < 0 || start + phrase.length > tokens.length) return false
  const segment = tokens[start].segment
  return phrase.every((word, offset) => tokens[start + offset].text === word && tokens[start + offset].segment === segment)
}

function maskPhraseAt(tokens: Token[], start: number, phrase: readonly string[]): void {
  for (let offset = 0; offset < phrase.length; offset++) tokens[start + offset] = { ...tokens[start + offset], text: MASK }
}

function maskPhrases(tokens: Token[], phrases: readonly (readonly string[])[]): void {
  for (let i = 0; i < tokens.length; i++) {
    for (const phrase of phrases) if (isPhrase(tokens, i, phrase)) maskPhraseAt(tokens, i, phrase)
  }
}

function containsPhrase(tokens: Token[], phrases: readonly (readonly string[])[]): boolean {
  for (let i = 0; i < tokens.length; i++) {
    for (const phrase of phrases) if (isPhrase(tokens, i, phrase)) return true
  }
  return false
}

function actMatches(pack: Pack, tokens: Token[]): ActMatch[] {
  const matches: ActMatch[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    const previous = tokens[i - 1]
    const afterTer = previous && previous.segment === token.segment && pack.terAux.has(previous.text)

    if (pack.terParticiples.has(token.text)) {
      // "tenho transado" is an act; bare "transado" ("ele é transado") is not.
      if (afterTer) matches.push({ start: i, end: i + 1, segment: token.segment, person: 'open' })
    } else if (pack.firstActs.has(token.text)) {
      matches.push({ start: i, end: i + 1, segment: token.segment, person: 'first' })
    } else if (pack.secondActs.has(token.text)) {
      matches.push({ start: i, end: i + 1, segment: token.segment, person: 'second' })
    } else if (pack.openActs.has(token.text)) {
      matches.push({ start: i, end: i + 1, segment: token.segment, person: 'open' })
    }

    for (const phrase of pack.actPhrases) {
      if (isPhrase(tokens, i, phrase.words)) {
        matches.push({ start: i, end: i + phrase.words.length, segment: token.segment, person: phrase.person })
      }
    }
  }
  return matches
}

/**
 * "Conversamos sobre sexo com minha irmã" is a conversation. An act phrase that
 * begins with `sexo` right after `sobre`, or after `de` with a speech verb just
 * before, is dropped.
 */
function talkingAboutIt(tokens: Token[], match: ActMatch): boolean {
  if (tokens[match.start]?.text !== 'sexo') return false
  const before = tokens[match.start - 1]
  if (!before || before.segment !== match.segment) return false
  if (before.text === 'sobre') return true
  if (before.text !== 'de') return false
  // A speech verb among the four tokens before the act phrase.
  for (let i = Math.max(0, match.start - 4); i < match.start - 1; i++) {
    if (tokens[i].segment === match.segment && SPEECH_VERBS.has(tokens[i].text)) return true
  }
  return false
}

function ageNumber(pack: Pack, token: string | undefined): number | undefined {
  if (!token) return undefined
  const word = pack.ageWords.get(token)
  if (word !== undefined) return word
  if (!/^\p{N}+$/u.test(token)) return undefined
  return Number(token)
}

function pluralArticle(pack: Pack, tokens: Token[], index: number): boolean {
  const before = tokens[index - 1]
  if (!before || before.segment !== tokens[index].segment) return false
  return pack.pluralArticles.has(before.text)
}

/** An age written right beside a minor noun: "a menina de 12 anos", "la niña, 11 años". */
function hasStatedAgeAfter(pack: Pack, tokens: Token[], index: number): boolean {
  let i = index + 1
  while (tokens[i]?.text === 'de' || tokens[i]?.text === 'que') i++
  if (pack.ageVerbs.has(tokens[i]?.text ?? '')) i++
  const value = ageNumber(pack, tokens[i]?.text)
  if (value === undefined || value < 1 || value > 17) return false
  return pack.ageUnits.has(tokens[i + 1]?.text ?? '')
}

/**
 * The complement slot: an optional connector, an optional article, a possessive,
 * an optional `própria`, then a noun. One arbitrary token is tolerated before a
 * real connector, so "transou hoje com a irmã" still finds its object while
 * "transou e minha irmã" (two clauses) does not.
 */
function resolveObject(pack: Pack, tokens: Token[], start: number, segment: number): ObjectRef | null {
  let i = start
  if (tokens[i]?.segment !== segment) return null
  if (pack.connectors.has(tokens[i].text)) i++
  let article: string | undefined
  if (tokens[i]?.segment === segment && pack.articles.has(tokens[i].text)) article = tokens[i++].text
  let possessive: string | undefined
  if (tokens[i]?.segment === segment && pack.possessives.has(tokens[i].text)) possessive = tokens[i++].text
  let own = false
  if (tokens[i]?.segment === segment && pack.own.has(tokens[i].text)) {
    own = true
    i++
  }
  if (tokens[i]?.segment !== segment) return null
  return { nounIndex: i, article, possessive, own }
}

function objectsAfter(pack: Pack, tokens: Token[], match: ActMatch): ObjectRef[] {
  const refs: ObjectRef[] = []
  const direct = resolveObject(pack, tokens, match.end, match.segment)
  if (direct) refs.push(direct)
  const skipped = match.end + 1
  if (tokens[skipped]?.segment === match.segment && pack.connectors.has(tokens[skipped].text)) {
    const viaSkip = resolveObject(pack, tokens, skipped, match.segment)
    if (viaSkip) refs.push(viaSkip)
  }
  return refs
}

/** "nunca transei com minha irmã" is clear; "não paro de transar com ela" is not. */
function denies(pack: Pack, tokens: Token[], match: ActMatch): boolean {
  for (let i = match.start - 1; i >= Math.max(0, match.start - 4); i--) {
    if (tokens[i].segment !== match.segment) break
    if (!pack.negators.has(tokens[i].text)) continue
    for (let j = i + 1; j < match.start; j++) if (DENIAL_STOPPERS.has(tokens[j].text)) return false
    return true
  }
  return false
}

function opensClause(tokens: Token[], match: ActMatch): boolean {
  return match.start === 0 || tokens[match.start - 1].segment !== match.segment
}

/** A first-person marker governs the act when only light words separate them. */
function markerGoverns(pack: Pack, tokens: Token[], match: ActMatch): boolean {
  for (let i = match.start - 1; i >= 0; i--) {
    if (tokens[i].segment !== match.segment) return false
    if (pack.markers.has(tokens[i].text)) return true
    for (const phrase of pack.markerPhrases) {
      if (isPhrase(tokens, i - phrase.length + 1, phrase)) return true
    }
    // "eu tinha transado com minha irmã": the auxiliary does not hide the marker.
    if (pack.terAux.has(tokens[i].text)) continue
    if (!LIGHT.has(tokens[i].text)) return false
  }
  return false
}

/** Portuguese `você` + `seu/sua` in the same clause: the relative is the addressee's. */
function youNear(pack: Pack, tokens: Token[], match: ActMatch): boolean {
  if (pack.youMarkers.size === 0) return false
  for (let i = match.start - 1; i >= Math.max(0, match.start - 3); i--) {
    if (tokens[i].segment !== match.segment) return false
    if (pack.youMarkers.has(tokens[i].text)) return true
  }
  return false
}

/**
 * Someone else may be in the sentence: a gerund or a place phrase after the noun
 * says the object is not the one in the act. Any marker clears a family noun and
 * a plural minor; a singular minor clears only on "ao lado".
 */
function elsewhereNearby(tokens: Token[], nounIndex: number, allMarkers: boolean): boolean {
  const segment = tokens[nounIndex].segment
  const last = Math.min(tokens.length - 1, nounIndex + 5)
  for (let i = nounIndex + 1; i <= last; i++) {
    if (tokens[i].segment !== segment) break
    const word = tokens[i].text
    if (allMarkers) {
      if (GERUND.test(word) && !NOT_GERUNDS.has(word)) return true
      if (ELSEWHERE_ADJECTIVES.has(word)) return true
      if (ELSEWHERE_PHRASES.some((phrase) => isPhrase(tokens, i, phrase))) return true
    } else if (BESIDE_PHRASES.some((phrase) => isPhrase(tokens, i, phrase))) {
      return true
    }
  }
  return false
}

function minorObjectBlocks(pack: Pack, tokens: Token[], ref: ObjectRef): boolean {
  const token = tokens[ref.nounIndex].text
  const definitePlural = ref.article !== undefined && pack.definitePluralArticles.has(ref.article)
  let hit = false
  if (pack.minorAlways.has(token)) hit = true
  else if (pack.minorPhrases.some((phrase) => isPhrase(tokens, ref.nounIndex, phrase))) hit = true
  else if (pack.pluralMinor.has(token) && pluralArticle(pack, tokens, ref.nounIndex)) hit = true
  else if (pack.minorWithAge.has(token) && hasStatedAgeAfter(pack, tokens, ref.nounIndex)) hit = true
  if (!hit) return false
  return !elsewhereNearby(tokens, ref.nounIndex, definitePlural)
}

/** "crianças transando": the minor is the one acting, not the object after it. */
function minorActs(pack: Pack, tokens: Token[], match: ActMatch): boolean {
  const before = tokens[match.start - 1]
  if (!before || before.segment !== match.segment || !GERUND.test(tokens[match.start].text)) return false
  return pack.minorAlways.has(before.text) || pack.pluralMinor.has(before.text)
}

function familyBlocks(pack: Pack, tokens: Token[], match: ActMatch, ref: ObjectRef): boolean {
  if (!pack.family.has(tokens[ref.nounIndex].text)) return false
  if (!ref.own && !ref.possessive) return false
  if (elsewhereNearby(tokens, ref.nounIndex, true)) return false
  if (ref.own) return true

  const possessive = ref.possessive!
  if (pack.firstPoss.has(possessive)) {
    if (match.person === 'first') return true
    if (match.person === 'open') return opensClause(tokens, match) || markerGoverns(pack, tokens, match)
    return false
  }
  if (pack.secondPoss.has(possessive)) return match.person === 'second'
  return youNear(pack, tokens, match)
}

function pronounAfterAct(tokens: Token[], acts: ActMatch[]): boolean {
  for (const match of acts) {
    for (const start of [match.end, match.end + 1]) {
      if (CHILD_PRONOUNS.some((phrase) => isPhrase(tokens, start, phrase))) return true
    }
  }
  return false
}

/**
 * A stated age of a minor, only when the sentence also holds a live act. Lenient
 * by construction: the unit must be followed by the end of the clause, a
 * conjunction or "de idade", so "tengo 5 años sin tener sexo" and "tem 10 anos a
 * mais" are not ages of minors.
 */
function statesMinorAge(pack: Pack, tokens: Token[], acts: ActMatch[]): boolean {
  for (let i = 0; i < tokens.length; i++) {
    if (!pack.ageVerbs.has(tokens[i].text)) continue
    const value = ageNumber(pack, tokens[i + 1]?.text)
    if (value === undefined || value < 1 || value > 17) continue
    const unit = tokens[i + 2]
    if (!unit || unit.segment !== tokens[i].segment || !pack.ageUnits.has(unit.text)) continue

    const after = tokens[i + 3]
    const sameClause = !!after && after.segment === tokens[i].segment
    const counts = !sameClause || pack.ageFollows.has(after!.text) ||
      (after!.text === 'de' && tokens[i + 4]?.text === pack.ageOfMinor && tokens[i + 4]!.segment === tokens[i].segment)
    if (!counts) continue

    const subject = tokens[i - 1]
    const subjectInClause = !!subject && subject.segment === tokens[i].segment
    if (pack.ageThirdPerson.has(tokens[i].text) && subjectInClause && THING_SUBJECTS.has(subject!.text)) continue

    const owner = tokens[i - 2]
    const possessedChild = subjectInClause && !!owner && owner.segment === tokens[i].segment &&
      pack.childPossessives.has(owner.text) && pack.childNouns.has(subject!.text)
    if (possessedChild && !pronounAfterAct(tokens, acts)) continue
    return true
  }
  return false
}

/** A negator close before one coded occurrence clears that occurrence only. */
function negatedOccurrence(pack: Pack, tokens: Token[], index: number): boolean {
  const segment = tokens[index].segment
  for (let i = index - 1; i >= Math.max(0, index - 3); i--) {
    if (tokens[i].segment !== segment) return false
    if (CODED_BLOCKERS.has(tokens[i].text)) return false
    if (pack.codedNegators.has(tokens[i].text)) return true
  }
  return false
}

function maskClearedCoded(pack: Pack, tokens: Token[]): void {
  for (let i = 0; i < tokens.length; i++) {
    for (const phrase of pack.coded) {
      if (isPhrase(tokens, i, phrase) && negatedOccurrence(pack, tokens, i)) maskPhraseAt(tokens, i, phrase)
    }
  }
}

function verdict(category: GuardCategory): GuardVerdict {
  return { blocked: true, category, message: GUARD_MESSAGES[category] }
}

/**
 * Screen one player message in a save's language. Unknown and English languages
 * are clear — English uses `screenPlayerInput`, which is where it always ran.
 */
export function screenPlayerInputIn(language: string | null | undefined, text: string): GuardVerdict {
  if (!text || typeof text !== 'string') return { blocked: false }
  if (typeof language !== 'string') return { blocked: false }
  const code = language.trim().toLowerCase().split(/[-_]/)[0]
  const pack = PACKS.get(code)
  if (!pack) return { blocked: false }

  for (const sentence of splitSentences(text)) {
    const tokens = tokenize(normalize(sentence, pack))
    maskPhrases(tokens, pack.idioms)
    maskClearedCoded(pack, tokens)

    const acts = actMatches(pack, tokens).filter((match) => !talkingAboutIt(tokens, match))
    if (acts.length === 0) continue
    const live = acts.filter((match) => !denies(pack, tokens, match))

    if (GUARD_CATEGORIES.minor_sexual) {
      for (const match of live) {
        if (minorActs(pack, tokens, match)) return verdict('minor_sexual')
        for (const ref of objectsAfter(pack, tokens, match)) {
          if (minorObjectBlocks(pack, tokens, ref)) return verdict('minor_sexual')
        }
      }
      if (statesMinorAge(pack, tokens, live) || containsPhrase(tokens, pack.coded)) return verdict('minor_sexual')
    }

    if (GUARD_CATEGORIES.incest) {
      for (const match of live) {
        for (const ref of objectsAfter(pack, tokens, match)) {
          if (familyBlocks(pack, tokens, match, ref)) return verdict('incest')
        }
      }
    }
  }

  return { blocked: false }
}

/**
 * Does this line describe a sexual act at all, in a save's language? Same packs,
 * sentence loop and masking as `screenPlayerInputIn`, but it drops the family
 * and minor tests and keeps the act test: a live act is one that is not a
 * conversation about it (`talkingAboutIt`) and not denied (`denies`).
 *
 * The same-turn router's fallback lexicon is English vocabulary, so routing a
 * Portuguese or Spanish turn on THAT word score reads a native line as zero.
 * This answers the one question that gap needs. Unknown and English languages
 * are false — English routing stays on `scoreScene`, which is where it ran.
 */
export function sexualActIn(language: string | null | undefined, text: string): boolean {
  if (!text || typeof text !== 'string') return false
  if (typeof language !== 'string') return false
  const code = language.trim().toLowerCase().split(/[-_]/)[0]
  const pack = PACKS.get(code)
  if (!pack) return false

  for (const sentence of splitSentences(text)) {
    const tokens = tokenize(normalize(sentence, pack))
    maskPhrases(tokens, pack.idioms)
    maskClearedCoded(pack, tokens)

    const acts = actMatches(pack, tokens).filter((match) => !talkingAboutIt(tokens, match))
    if (acts.some((match) => !denies(pack, tokens, match))) return true
  }

  return false
}
