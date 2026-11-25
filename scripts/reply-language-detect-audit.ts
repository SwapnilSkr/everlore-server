/**
 * REPLY LANGUAGE DETECTION (the Jev decision): the exact request, the 0.9
 * floor, the malformed shapes, the 700 ms first-turn wait and the recorded
 * corpus replay. Pure: no network, no DB, a fake transport and a fake clock.
 *
 *   bun --no-env-file run scripts/reply-language-detect-audit.ts
 *   bun --no-env-file run scripts/reply-language-detect-audit.ts --bites
 */
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { startingLanguage, type ReplyLanguageEntry } from '../src/utils/reply-language'
import {
  DECISION_TIMEOUT_MS,
  MIN_DECISION_PROBABILITY,
  REPLY_LANGUAGE_WAIT_MS,
  buildReplyLanguageRequest,
  checkReplyLanguage,
  matchesOfferedChip,
  parseReplyLanguageDecision,
  replyLanguageWaitMs,
  shouldStartReplyLanguageCheck,
  startReplyLanguageCheck,
  type ReplyLanguageCheckResult,
  type ReplyLanguageHttpResponse,
  type ReplyLanguageTransport,
} from '../worker/lib/reply-language-check'

const PT: ReplyLanguageEntry = { code: 'pt', name: 'Brazilian Portuguese', label: 'Português' }
const ES: ReplyLanguageEntry = { code: 'es', name: 'Spanish', label: 'Español' }
const ENTRIES = [PT, ES]
const ENABLED = ['pt', 'es']

interface RecordedLine {
  k: 'pt' | 'es' | 'en' | 'other'
  t: string
  u?: boolean
  v: string
  ask: string | null
  p: Record<string, number>
  ms: number
  c: number
}

// The recorded decisions corpus (`.agents/ref/rl-d/jev.json` and `jev2.json`,
// jev arm only). Synthetic authored lines: the `real` category is not here.
const RECORDED: RecordedLine[] = [{"k":"pt","t":"olá","u":true,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":910.252125,"c":2.3772e-05},{"k":"pt","t":"oi","u":true,"v":"pt","ask":"none","p":{"pt":0.81,"es":0.03,"en":0.01,"other":0.15},"ms":944.2260420000001,"c":2.3729999999999998e-05},{"k":"pt","t":"oi tudo bem?","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":460.288625,"c":2.3856e-05},{"k":"pt","t":"oi linda","u":true,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":469.3784170000001,"c":2.3772e-05},{"k":"pt","t":"bom dia","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":469.4620830000001,"c":2.3772e-05},{"k":"pt","t":"boa noite Marigold","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":455.78424999999993,"c":2.3898e-05},{"k":"pt","t":"quem é você?","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":461.5998750000001,"c":2.3856e-05},{"k":"pt","t":"quem e vc","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":453.9862919999998,"c":2.3814e-05},{"k":"pt","t":"onde eu to","u":true,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":462.9066250000001,"c":2.3814e-05},{"k":"pt","t":"onde estou?","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":449.2890000000002,"c":2.3814e-05},{"k":"pt","t":"o que aconteceu?","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":458.1888329999997,"c":2.3856e-05},{"k":"pt","t":"que lugar é esse","u":false,"v":"pt","ask":"none","p":{"pt":0.99,"es":0.01,"en":0,"other":0},"ms":496.4949160000001,"c":2.3856e-05},{"k":"pt","t":"oq aconteceu cmg","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":463.76704199999995,"c":2.3856e-05},{"k":"pt","t":"nao lembro de nada","u":true,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":475.226416,"c":2.3898e-05},{"k":"pt","t":"eu não sei","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":443.19483400000036,"c":2.3814e-05},{"k":"pt","t":"sei la","u":true,"v":"other","ask":"none","p":{"pt":0.03,"es":0.12,"en":0,"other":0.85},"ms":499.60949999999957,"c":2.3772e-05},{"k":"pt","t":"sim","u":true,"v":"pt","ask":"none","p":{"pt":0.52,"es":0.06,"en":0.01,"other":0.41},"ms":463.97491700000046,"c":2.3729999999999998e-05},{"k":"pt","t":"claro que sim","u":true,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":462.85054200000013,"c":2.3856e-05},{"k":"pt","t":"nunca","u":true,"v":"es","ask":"none","p":{"pt":0.07,"es":0.49,"en":0,"other":0.44},"ms":469.44758399999955,"c":2.3772e-05},{"k":"pt","t":"talvez","u":true,"v":"pt","ask":"none","p":{"pt":0.97,"es":0,"en":0,"other":0.03},"ms":480.23183400000016,"c":2.3772e-05},{"k":"pt","t":"obrigado","u":true,"v":"pt","ask":"none","p":{"pt":0.99,"es":0,"en":0,"other":0.01},"ms":461.1223749999999,"c":2.3814e-05},{"k":"pt","t":"obg pela ajuda","u":true,"v":"pt","ask":"none","p":{"pt":0.99,"es":0.01,"en":0,"other":0},"ms":564.5242500000004,"c":2.3856e-05},{"k":"pt","t":"valeu","u":true,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":441.90200000000004,"c":2.3772e-05},{"k":"pt","t":"vc fala portugues?","u":false,"v":"pt","ask":"pt","p":{"pt":1,"es":0,"en":0,"other":0},"ms":465.0200840000007,"c":2.3856e-05},{"k":"pt","t":"fala em português por favor","u":false,"v":"pt","ask":"pt","p":{"pt":1,"es":0,"en":0,"other":0},"ms":478.55125000000044,"c":2.3898e-05},{"k":"pt","t":"pode falar portugues","u":false,"v":"pt","ask":"pt","p":{"pt":1,"es":0,"en":0,"other":0},"ms":463.8712919999998,"c":2.3856e-05},{"k":"pt","t":"em portugues pfv","u":false,"v":"pt","ask":"pt","p":{"pt":1,"es":0,"en":0,"other":0},"ms":442.2396660000004,"c":2.3856e-05},{"k":"pt","t":"nao falo ingles","u":true,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":470.9956250000005,"c":2.3898e-05},{"k":"pt","t":"não entendi nada","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":462.0665419999996,"c":2.3856e-05},{"k":"pt","t":"como assim","u":false,"v":"pt","ask":"none","p":{"pt":0.93,"es":0.04,"en":0,"other":0.03},"ms":471.5906249999998,"c":2.3772e-05},{"k":"pt","t":"kkkkk","u":true,"v":"other","ask":"none","p":{"pt":0.04,"es":0.03,"en":0.07,"other":0.86},"ms":459.3309159999999,"c":2.3814e-05},{"k":"pt","t":"kkkk que isso mano","u":true,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":497.68595899999946,"c":2.3898e-05},{"k":"pt","t":"mds","u":true,"v":"other","ask":"none","p":{"pt":0.03,"es":0.09,"en":0.19,"other":0.69},"ms":477.2490420000013,"c":2.3772e-05},{"k":"pt","t":"caramba que lindo","u":true,"v":"pt","ask":"none","p":{"pt":0.91,"es":0.07,"en":0,"other":0.02},"ms":541.3572910000003,"c":2.3856e-05},{"k":"pt","t":"eu levanto devagar","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":453.97854200000074,"c":2.3898e-05},{"k":"pt","t":"*levanto da cama*","u":true,"v":"pt","ask":"none","p":{"pt":0.97,"es":0.03,"en":0,"other":0},"ms":458.85520800000086,"c":2.3939999999999998e-05},{"k":"pt","t":"*olho em volta*","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":465.95858299999963,"c":2.3939999999999998e-05},{"k":"pt","t":"*eu sorrio e seguro sua mão*","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":463.4359169999989,"c":2.4066e-05},{"k":"pt","t":"*me aproximo dela*","u":false,"v":"pt","ask":"none","p":{"pt":0.96,"es":0.04,"en":0,"other":0},"ms":491.76429199999984,"c":2.3939999999999998e-05},{"k":"pt","t":"beijo ela","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":501.43962499999907,"c":2.3814e-05},{"k":"pt","t":"beijo o pescoço dela","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":471.4390829999993,"c":2.3982e-05},{"k":"pt","t":"eu te beijo","u":true,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":473.1787910000003,"c":2.3856e-05},{"k":"pt","t":"te amo","u":true,"v":"es","ask":"none","p":{"pt":0.04,"es":0.88,"en":0,"other":0.08},"ms":460.8162080000002,"c":2.3772e-05},{"k":"pt","t":"eu te amo Marigold","u":true,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":460.21987499999886,"c":2.3939999999999998e-05},{"k":"pt","t":"to com fome","u":true,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":464.2597910000004,"c":2.3814e-05},{"k":"pt","t":"estou com sede","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":468.28641699999935,"c":2.3856e-05},{"k":"pt","t":"tem comida?","u":false,"v":"pt","ask":"none","p":{"pt":0.98,"es":0.02,"en":0,"other":0},"ms":446.90141700000095,"c":2.3814e-05},{"k":"pt","t":"quero ir embora","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":451.35412499999984,"c":2.3856e-05},{"k":"pt","t":"quero comer alguma coisa","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":807.0306669999991,"c":2.3898e-05},{"k":"pt","t":"quero ir pra casa","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":458.6854999999996,"c":2.3898e-05},{"k":"pt","t":"vamos sair daqui","u":false,"v":"pt","ask":"none","p":{"pt":0.98,"es":0.02,"en":0,"other":0},"ms":481.0671249999996,"c":2.3856e-05},{"k":"pt","t":"vamos pra floresta","u":true,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":474.5528750000012,"c":2.3939999999999998e-05},{"k":"pt","t":"me leva até o porto","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":449.3832089999996,"c":2.3898e-05},{"k":"pt","t":"onde fica a vila","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":451.95845799999915,"c":2.3856e-05},{"k":"pt","t":"meu nome é Daniel","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":495.9683329999989,"c":2.3898e-05},{"k":"pt","t":"me chamo Ana","u":true,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":495.3820000000014,"c":2.3856e-05},{"k":"pt","t":"sou o Pedro, prazer","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":480.4222499999996,"c":2.3898e-05},{"k":"pt","t":"tenho 25 anos","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":448.41983400000026,"c":2.3939999999999998e-05},{"k":"pt","t":"sou do Brasil","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":457.8350419999988,"c":2.3814e-05},{"k":"pt","t":"quanto tempo eu dormi?","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":438.007791,"c":2.3939999999999998e-05},{"k":"pt","t":"quem me trouxe aqui","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":452.2360000000008,"c":2.3856e-05},{"k":"pt","t":"cadê meu irmão","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":455.0886249999985,"c":2.3856e-05},{"k":"pt","t":"preciso encontrar minha irmã","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":454.85862500000076,"c":2.3898e-05},{"k":"pt","t":"voce viu meu barco","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":536.5857919999999,"c":2.3898e-05},{"k":"pt","t":"me ajuda","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":471.67362499999945,"c":2.3772e-05},{"k":"pt","t":"me ajuda por favor","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":450.18483299999934,"c":2.3856e-05},{"k":"pt","t":"obrigado por me salvar","u":true,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":476.679583000001,"c":2.3939999999999998e-05},{"k":"pt","t":"desculpa","u":true,"v":"pt","ask":"none","p":{"pt":0.99,"es":0,"en":0,"other":0.01},"ms":462.0727079999997,"c":2.3814e-05},{"k":"pt","t":"me desculpe por ontem","u":true,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":464.00237500000003,"c":2.3939999999999998e-05},{"k":"pt","t":"tá bom","u":true,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":442.8579580000005,"c":2.3814e-05},{"k":"pt","t":"ta bom entao vamos","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":486.0615409999991,"c":2.3898e-05},{"k":"pt","t":"pode ser","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":448.6275000000023,"c":2.3814e-05},{"k":"pt","t":"acho que sim","u":false,"v":"pt","ask":"none","p":{"pt":0.99,"es":0.01,"en":0,"other":0},"ms":466.38224999999875,"c":2.3814e-05},{"k":"pt","t":"acho que nao","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":505.74449999999706,"c":2.3814e-05},{"k":"pt","t":"deixa eu ver","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":454.53358300000036,"c":2.3856e-05},{"k":"pt","t":"espera um pouco","u":false,"v":"pt","ask":"none","p":{"pt":0.96,"es":0.04,"en":0,"other":0},"ms":443.90179200000057,"c":2.3856e-05},{"k":"pt","t":"fica comigo","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":1261.5929169999981,"c":2.3772e-05},{"k":"pt","t":"calma","u":true,"v":"es","ask":"none","p":{"pt":0.08,"es":0.47,"en":0,"other":0.45},"ms":1593.450458000003,"c":2.3772e-05},{"k":"pt","t":"não vai embora","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":1180.5610829999969,"c":2.3814e-05},{"k":"pt","t":"voce é muito bonita","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":1300.6304170000003,"c":2.3898e-05},{"k":"pt","t":"que cheiro bom","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":549.7717499999999,"c":2.3856e-05},{"k":"pt","t":"seus olhos são lindos","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":947.6011249999974,"c":2.3939999999999998e-05},{"k":"pt","t":"senta aqui do meu lado","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":490.24066700000185,"c":2.3939999999999998e-05},{"k":"pt","t":"conta mais sobre você","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":478.37620799999786,"c":2.3898e-05},{"k":"pt","t":"me conta sua historia","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":950.3704580000012,"c":2.3856e-05},{"k":"pt","t":"e depois?","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":471.82550000000265,"c":2.3814e-05},{"k":"pt","t":"porque vc ta triste","u":true,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":453.36808400000155,"c":2.3856e-05},{"k":"pt","t":"por que você fez isso","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":941.594291999998,"c":2.3898e-05},{"k":"pt","t":"o que foi","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":465.0732500000013,"c":2.3814e-05},{"k":"pt","t":"que foi isso","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":538.4583329999987,"c":2.3814e-05},{"k":"pt","t":"quem ta ai","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":451.06254199999967,"c":2.3814e-05},{"k":"pt","t":"abro a porta","u":true,"v":"pt","ask":"none","p":{"pt":0.97,"es":0.03,"en":0,"other":0},"ms":443.16045799999847,"c":2.3856e-05},{"k":"pt","t":"fecho a porta e saio correndo","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":463.21270800000275,"c":2.4066e-05},{"k":"pt","t":"pego a espada","u":true,"v":"pt","ask":"none","p":{"pt":0.98,"es":0.02,"en":0,"other":0},"ms":439.4834579999988,"c":2.3898e-05},{"k":"pt","t":"ataco o guarda","u":true,"v":"pt","ask":"none","p":{"pt":0.75,"es":0.24,"en":0,"other":0.01},"ms":452.56245800000033,"c":2.3856e-05},{"k":"pt","t":"eu me escondo atrás da árvore","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":511.312334000002,"c":2.4108e-05},{"k":"pt","t":"corro em direção ao castelo","u":false,"v":"pt","ask":"none","p":{"pt":0.97,"es":0.03,"en":0,"other":0},"ms":465.273416,"c":2.3982e-05},{"k":"pt","t":"ajudo ela a levantar","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":468.62270799999897,"c":2.3898e-05},{"k":"pt","t":"olho pela janela","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":985.1241250000021,"c":2.3856e-05},{"k":"pt","t":"pergunto o nome dela","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":472.1981659999983,"c":2.3939999999999998e-05},{"k":"pt","t":"dou risada","u":true,"v":"pt","ask":"none","p":{"pt":0.99,"es":0,"en":0,"other":0.01},"ms":501.6571670000012,"c":2.3814e-05},{"k":"pt","t":"fico em silêncio","u":false,"v":"pt","ask":"none","p":{"pt":0.99,"es":0.01,"en":0,"other":0},"ms":485.61354199999914,"c":2.3814e-05},{"k":"pt","t":"respiro fundo e digo que sim","u":true,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":459.0102909999987,"c":2.3982e-05},{"k":"pt","t":"\"não se preocupe\", eu digo","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":477.4342910000014,"c":2.4108e-05},{"k":"pt","t":"\"quem está aí?\" *pergunto com medo*","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":452.74774999999863,"c":2.4191999999999998e-05},{"k":"pt","t":"vou dormir","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":476.44745800000237,"c":2.3772e-05},{"k":"pt","t":"to cansado","u":false,"v":"pt","ask":"none","p":{"pt":0.83,"es":0.15,"en":0,"other":0.02},"ms":541.9984999999979,"c":2.3814e-05},{"k":"pt","t":"amanhã a gente conversa","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":471.9082500000004,"c":2.3939999999999998e-05},{"k":"pt","t":"que saudade de vc","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":467.72858300000007,"c":2.3898e-05},{"k":"pt","t":"tô com saudade","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":925.8472909999982,"c":2.3898e-05},{"k":"pt","t":"tem namorado?","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":505.27016699999876,"c":2.3898e-05},{"k":"pt","t":"posso te dar um abraço","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":460.7846669999999,"c":2.3982e-05},{"k":"pt","t":"vc é casada?","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":1350.6034999999974,"c":2.3898e-05},{"k":"pt","t":"me abraça","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":449.070334,"c":2.3814e-05},{"k":"pt","t":"tira a roupa","u":true,"v":"pt","ask":"none","p":{"pt":0.9,"es":0.09,"en":0,"other":0.01},"ms":459.17212500000096,"c":2.3856e-05},{"k":"pt","t":"vem cá","u":true,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":444.2321669999983,"c":2.3772e-05},{"k":"pt","t":"vem aqui gostosa","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":456.8219590000008,"c":2.3856e-05},{"k":"pt","t":"to de boa","u":true,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":471.8115829999988,"c":2.3814e-05},{"k":"pt","t":"de boa e vc","u":true,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":474.5187499999993,"c":2.3856e-05},{"k":"pt","t":"beleza","u":true,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":441.02366600000096,"c":2.3772e-05},{"k":"pt","t":"blz mano","u":true,"v":"pt","ask":"none","p":{"pt":0.92,"es":0.03,"en":0.01,"other":0.04},"ms":471.869917,"c":2.3814e-05},{"k":"pt","t":"fala sério","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":454.91058399999747,"c":2.3772e-05},{"k":"pt","t":"que horas são","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":470.26558300000397,"c":2.3814e-05},{"k":"pt","t":"ta chovendo","u":true,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":951.2025409999987,"c":2.3856e-05},{"k":"pt","t":"onde vc mora","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":836.5538749999978,"c":2.3814e-05},{"k":"pt","t":"eu confio em você","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":447.627916999998,"c":2.3898e-05},{"k":"pt","t":"não confio nele","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":557.5148330000011,"c":2.3856e-05},{"k":"pt","t":"prometo que volto","u":true,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":438.0332500000004,"c":2.3856e-05},{"k":"pt","t":"eu juro","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":459.18320899999526,"c":2.3814e-05},{"k":"pt","t":"nada","u":true,"v":"es","ask":"none","p":{"pt":0.03,"es":0.7,"en":0,"other":0.27},"ms":517.8561669999981,"c":2.3772e-05},{"k":"pt","t":"nada demais","u":true,"v":"pt","ask":"none","p":{"pt":0.98,"es":0.01,"en":0,"other":0.01},"ms":462.18458400000236,"c":2.3814e-05},{"k":"pt","t":"continue a historia","u":true,"v":"pt","ask":"pt","p":{"pt":1,"es":0,"en":0,"other":0},"ms":485.5551669999986,"c":2.3814e-05},{"k":"pt","t":"continua","u":true,"v":"other","ask":"none","p":{"pt":0.28,"es":0.21,"en":0,"other":0.51},"ms":956.3054169999959,"c":2.3814e-05},{"k":"pt","t":"muda de assunto","u":false,"v":"pt","ask":"none","p":{"pt":0.99,"es":0.01,"en":0,"other":0},"ms":468.59999999999854,"c":2.3856e-05},{"k":"pt","t":"eu morri?","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":457.06841699999495,"c":2.3856e-05},{"k":"pt","t":"isso é um sonho?","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":788.8497500000012,"c":2.3898e-05},{"k":"pt","t":"to perdido","u":true,"v":"es","ask":"none","p":{"pt":0.36,"es":0.62,"en":0,"other":0.02},"ms":470.54429200000595,"c":2.3772e-05},{"k":"pt","t":"quero saber a verdade","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":449.596666999998,"c":2.3898e-05},{"k":"pt","t":"me fala a verdade","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":458.68408400000044,"c":2.3856e-05},{"k":"pt","t":"quero ver o mar","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":516.1625420000055,"c":2.3898e-05},{"k":"pt","t":"eu tambem","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":471.9225000000006,"c":2.3814e-05},{"k":"pt","t":"tambem te quero","u":true,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":442.21875,"c":2.3856e-05},{"k":"pt","t":"legal","u":true,"v":"en","ask":"none","p":{"pt":0.01,"es":0.01,"en":0.78,"other":0.2},"ms":503.2579160000023,"c":2.3729999999999998e-05},{"k":"pt","t":"muito legal isso","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":478.27116599999863,"c":2.3856e-05},{"k":"pt","t":"que história incrível, continua","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":492.2108750000043,"c":2.3898e-05},{"k":"es","t":"hola","u":true,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":492.9119999999966,"c":2.3729999999999998e-05},{"k":"es","t":"hola qué tal","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":471.61554199999955,"c":2.3814e-05},{"k":"es","t":"hola como estas","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":509.3427920000031,"c":2.3814e-05},{"k":"es","t":"hola guapa","u":true,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":469.97083399999974,"c":2.3814e-05},{"k":"es","t":"buenos días","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":465.9339590000018,"c":2.3856e-05},{"k":"es","t":"buenas noches Marigold","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":462.08350000000064,"c":2.3982e-05},{"k":"es","t":"quién eres?","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":448.9793750000026,"c":2.3856e-05},{"k":"es","t":"quien eres tu","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":468.61845800000447,"c":2.3856e-05},{"k":"es","t":"donde estoy","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":457.9437079999989,"c":2.3814e-05},{"k":"es","t":"dónde estoy?","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":474.76950000000215,"c":2.3898e-05},{"k":"es","t":"que lugar es este","u":false,"v":"es","ask":"none","p":{"pt":0.02,"es":0.98,"en":0,"other":0},"ms":480.013374999995,"c":2.3856e-05},{"k":"es","t":"qué pasó?","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":472.5437910000037,"c":2.3814e-05},{"k":"es","t":"que paso","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":447.9780840000021,"c":2.3772e-05},{"k":"es","t":"no recuerdo nada","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":456.1895000000004,"c":2.3814e-05},{"k":"es","t":"no me acuerdo de nada","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":455.5612919999985,"c":2.3898e-05},{"k":"es","t":"no lo sé","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":530.8058750000055,"c":2.3814e-05},{"k":"es","t":"no se que decir","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":448.6397500000021,"c":2.3856e-05},{"k":"es","t":"sí","u":true,"v":"es","ask":"none","p":{"pt":0,"es":0.94,"en":0,"other":0.06},"ms":478.8643749999974,"c":2.3729999999999998e-05},{"k":"es","t":"si claro","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":448.13395899999887,"c":2.3772e-05},{"k":"es","t":"tal vez","u":false,"v":"es","ask":"none","p":{"pt":0.02,"es":0.93,"en":0,"other":0.05},"ms":442.6342499999955,"c":2.3772e-05},{"k":"es","t":"nunca","u":true,"v":"other","ask":"none","p":{"pt":0.09,"es":0.37,"en":0,"other":0.54},"ms":585.9927500000049,"c":2.3772e-05},{"k":"es","t":"gracias","u":true,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":452.42583300000115,"c":2.3772e-05},{"k":"es","t":"muchas gracias por todo","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":465.682458999996,"c":2.3939999999999998e-05},{"k":"es","t":"hablas español?","u":false,"v":"es","ask":"es","p":{"pt":0,"es":1,"en":0,"other":0},"ms":444.8030839999992,"c":2.3856e-05},{"k":"es","t":"puedes hablar español","u":false,"v":"es","ask":"es","p":{"pt":0,"es":1,"en":0,"other":0},"ms":464.3868750000038,"c":2.3856e-05},{"k":"es","t":"en español por favor","u":false,"v":"es","ask":"es","p":{"pt":0,"es":1,"en":0,"other":0},"ms":448.00058400000125,"c":2.3856e-05},{"k":"es","t":"habla en español","u":false,"v":"es","ask":"es","p":{"pt":0,"es":1,"en":0,"other":0},"ms":469.3800839999967,"c":2.3856e-05},{"k":"es","t":"no hablo ingles","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":447.93745800000033,"c":2.3856e-05},{"k":"es","t":"no entiendo nada","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":445.25729200000205,"c":2.3856e-05},{"k":"es","t":"cómo?","u":true,"v":"es","ask":"none","p":{"pt":0,"es":0.99,"en":0,"other":0.01},"ms":453.72029200000543,"c":2.3772e-05},{"k":"es","t":"no entiendo","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":1195.8949169999978,"c":2.3814e-05},{"k":"es","t":"jajaja","u":true,"v":"other","ask":"none","p":{"pt":0,"es":0.49,"en":0,"other":0.51},"ms":436.9935420000038,"c":2.3814e-05},{"k":"es","t":"jajaja que dices","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":456.2532910000009,"c":2.3898e-05},{"k":"es","t":"dios mio","u":true,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":455.4892919999984,"c":2.3814e-05},{"k":"es","t":"que lindo","u":true,"v":"pt","ask":"none","p":{"pt":0.77,"es":0.09,"en":0,"other":0.14},"ms":486.16633299999376,"c":2.3772e-05},{"k":"es","t":"me levanto despacio","u":false,"v":"es","ask":"none","p":{"pt":0.07,"es":0.93,"en":0,"other":0},"ms":458.53025000000343,"c":2.3898e-05},{"k":"es","t":"*me levanto de la cama*","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":464.48570800000016,"c":2.4024e-05},{"k":"es","t":"*miro alrededor*","u":false,"v":"es","ask":"none","p":{"pt":0.01,"es":0.98,"en":0,"other":0.01},"ms":449.9279999999999,"c":2.3898e-05},{"k":"es","t":"*sonrío y tomo su mano*","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":463.7974580000009,"c":2.4066e-05},{"k":"es","t":"*me acerco a ella*","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":435.28829200000473,"c":2.3982e-05},{"k":"es","t":"beso su cuello","u":false,"v":"es","ask":"none","p":{"pt":0.03,"es":0.97,"en":0,"other":0},"ms":452.1522079999995,"c":2.3856e-05},{"k":"es","t":"te beso","u":true,"v":"es","ask":"none","p":{"pt":0.01,"es":0.99,"en":0,"other":0},"ms":455.53579100000206,"c":2.3772e-05},{"k":"es","t":"la beso","u":true,"v":"es","ask":"none","p":{"pt":0.03,"es":0.95,"en":0,"other":0.02},"ms":1313.2525830000013,"c":2.3772e-05},{"k":"es","t":"te amo","u":true,"v":"es","ask":"none","p":{"pt":0.03,"es":0.93,"en":0,"other":0.04},"ms":474.3448749999952,"c":2.3772e-05},{"k":"es","t":"te amo Marigold","u":true,"v":"es","ask":"none","p":{"pt":0.02,"es":0.97,"en":0,"other":0.01},"ms":472.2966250000027,"c":2.3898e-05},{"k":"es","t":"tengo hambre","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":470.2719159999979,"c":2.3814e-05},{"k":"es","t":"tengo sed","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":459.1029589999962,"c":2.3814e-05},{"k":"es","t":"hay comida?","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":463.12724999999773,"c":2.3814e-05},{"k":"es","t":"quiero comer algo","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":469.773457999996,"c":2.3856e-05},{"k":"es","t":"quiero irme","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":479.16633299999376,"c":2.3856e-05},{"k":"es","t":"quiero ir a casa","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":478.9306250000009,"c":2.3898e-05},{"k":"es","t":"vamonos de aqui","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":446.66370800000004,"c":2.3898e-05},{"k":"es","t":"vamos al bosque","u":true,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":458.1523339999985,"c":2.3856e-05},{"k":"es","t":"llévame al puerto","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":456.21079199999804,"c":2.3898e-05},{"k":"es","t":"donde queda el pueblo","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":462.0949580000015,"c":2.3898e-05},{"k":"es","t":"mi nombre es Daniel","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":452.3924169999955,"c":2.3856e-05},{"k":"es","t":"soy Pedro, mucho gusto","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":463.8370419999992,"c":2.3898e-05},{"k":"es","t":"me llamo Ana","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":1189.1972920000044,"c":2.3898e-05},{"k":"es","t":"tengo 25 años","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":442.85508400000253,"c":2.3939999999999998e-05},{"k":"es","t":"soy de Argentina","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":455.57491599999776,"c":2.3814e-05},{"k":"es","t":"cuanto tiempo dormí","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":441.34479199999623,"c":2.3898e-05},{"k":"es","t":"quien me trajo aqui","u":true,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":539.0326249999998,"c":2.3939999999999998e-05},{"k":"es","t":"donde esta mi hermano","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":453.08816600000137,"c":2.3898e-05},{"k":"es","t":"viste mi barco?","u":true,"v":"es","ask":"none","p":{"pt":0.02,"es":0.98,"en":0,"other":0},"ms":446.8154160000049,"c":2.3898e-05},{"k":"es","t":"tengo que encontrar a mi hermana","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":473.28024999999616,"c":2.3982e-05},{"k":"es","t":"ayuda","u":true,"v":"es","ask":"none","p":{"pt":0,"es":0.99,"en":0,"other":0.01},"ms":452.1990420000002,"c":2.3772e-05},{"k":"es","t":"ayudame por favor","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":454.53191700000025,"c":2.3898e-05},{"k":"es","t":"gracias por salvarme","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":460.99575000000186,"c":2.3939999999999998e-05},{"k":"es","t":"perdón","u":true,"v":"es","ask":"none","p":{"pt":0,"es":0.99,"en":0,"other":0.01},"ms":480.6909579999992,"c":2.3814e-05},{"k":"es","t":"perdoname por lo de ayer","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":549.2242499999993,"c":2.3982e-05},{"k":"es","t":"está bien","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":560.7220420000012,"c":2.3814e-05},{"k":"es","t":"bueno entonces vamos","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":456.19983299999876,"c":2.3856e-05},{"k":"es","t":"puede ser","u":false,"v":"es","ask":"none","p":{"pt":0.01,"es":0.98,"en":0,"other":0.01},"ms":467.94208400000207,"c":2.3814e-05},{"k":"es","t":"creo que si","u":false,"v":"es","ask":"none","p":{"pt":0.02,"es":0.98,"en":0,"other":0},"ms":438.38229200000205,"c":2.3856e-05},{"k":"es","t":"creo que no","u":false,"v":"es","ask":"none","p":{"pt":0.02,"es":0.98,"en":0,"other":0},"ms":484.6380419999987,"c":2.3856e-05},{"k":"es","t":"dejame ver","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":451.4309579999972,"c":2.3814e-05},{"k":"es","t":"espera un momento","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":452.5928750000021,"c":2.3856e-05},{"k":"es","t":"tranquila","u":true,"v":"es","ask":"none","p":{"pt":0.06,"es":0.77,"en":0,"other":0.17},"ms":435.8612080000021,"c":2.3772e-05},{"k":"es","t":"quedate conmigo","u":false,"v":"es","ask":"none","p":{"pt":0.01,"es":0.99,"en":0,"other":0},"ms":470.9395829999994,"c":2.3856e-05},{"k":"es","t":"no te vayas","u":true,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":442.3127910000039,"c":2.3856e-05},{"k":"es","t":"eres muy hermosa","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":455.250165999998,"c":2.3814e-05},{"k":"es","t":"tus ojos son preciosos","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":448.7863750000033,"c":2.3982e-05},{"k":"es","t":"que rico huele","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":458.6345000000001,"c":2.3856e-05},{"k":"es","t":"sientate a mi lado","u":false,"v":"es","ask":"none","p":{"pt":0.01,"es":0.99,"en":0,"other":0},"ms":479.887917,"c":2.3939999999999998e-05},{"k":"es","t":"cuentame tu historia","u":false,"v":"es","ask":"es","p":{"pt":0,"es":1,"en":0,"other":0},"ms":558.7664579999982,"c":2.3898e-05},{"k":"es","t":"cuéntame más de ti","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":446.36858299999585,"c":2.3982e-05},{"k":"es","t":"y después?","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":484.81037500000093,"c":2.3814e-05},{"k":"es","t":"por qué hiciste eso","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":444.49970900000335,"c":2.3898e-05},{"k":"es","t":"porque estas triste","u":true,"v":"es","ask":"none","p":{"pt":0.06,"es":0.94,"en":0,"other":0},"ms":461.4527919999964,"c":2.3814e-05},{"k":"es","t":"que pasa","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":461.2627500000017,"c":2.3772e-05},{"k":"es","t":"quien anda ahi","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":452.09562499999447,"c":2.3856e-05},{"k":"es","t":"qué fue eso","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":874.3643749999974,"c":2.3814e-05},{"k":"es","t":"abro la puerta","u":false,"v":"es","ask":"none","p":{"pt":0.01,"es":0.99,"en":0,"other":0},"ms":534.5627500000046,"c":2.3856e-05},{"k":"es","t":"cierro la puerta y salgo corriendo","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":537.4355409999989,"c":2.4108e-05},{"k":"es","t":"tomo la espada","u":true,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":446.1070830000026,"c":2.3898e-05},{"k":"es","t":"ataco al guardia","u":true,"v":"es","ask":"none","p":{"pt":0.23,"es":0.76,"en":0,"other":0.01},"ms":457.50862499999494,"c":2.3939999999999998e-05},{"k":"es","t":"me escondo detrás del árbol","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":456.6336670000019,"c":2.3982e-05},{"k":"es","t":"corro hacia el castillo","u":false,"v":"es","ask":"none","p":{"pt":0.02,"es":0.98,"en":0,"other":0},"ms":453.35358299999643,"c":2.3939999999999998e-05},{"k":"es","t":"miro por la ventana","u":false,"v":"es","ask":"none","p":{"pt":0.01,"es":0.99,"en":0,"other":0},"ms":461.8798749999987,"c":2.3898e-05},{"k":"es","t":"la ayudo a levantarse","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":456.224209,"c":2.3982e-05},{"k":"es","t":"le pregunto su nombre","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":449.4731249999968,"c":2.3898e-05},{"k":"es","t":"me río","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":462.39404100000684,"c":2.3772e-05},{"k":"es","t":"me quedo en silencio","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":459.4804579999982,"c":2.3898e-05},{"k":"es","t":"respiro hondo y digo que si","u":false,"v":"es","ask":"none","p":{"pt":0.02,"es":0.98,"en":0,"other":0},"ms":473.80695800000103,"c":2.4024e-05},{"k":"es","t":"\"¿quién está ahí?\" *pregunto con miedo*","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":449.830667000002,"c":2.4234e-05},{"k":"es","t":"\"no te preocupes\", le digo","u":true,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":847.7683749999997,"c":2.4066e-05},{"k":"es","t":"me voy a dormir","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":459.78445900000224,"c":2.3856e-05},{"k":"es","t":"estoy cansado","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":464.00408400000015,"c":2.3856e-05},{"k":"es","t":"mañana hablamos","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":488.430583999987,"c":2.3856e-05},{"k":"es","t":"te extraño","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":450.479124999998,"c":2.3772e-05},{"k":"es","t":"te extrañe mucho","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":457.3735830000078,"c":2.3898e-05},{"k":"es","t":"estas casada?","u":true,"v":"es","ask":"none","p":{"pt":0.02,"es":0.98,"en":0,"other":0},"ms":449.1483750000043,"c":2.3856e-05},{"k":"es","t":"tienes novio?","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":465.63445800000045,"c":2.3898e-05},{"k":"es","t":"puedo darte un abrazo","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":447.8318750000035,"c":2.3898e-05},{"k":"es","t":"abrázame","u":true,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":468.6947910000017,"c":2.3814e-05},{"k":"es","t":"quítate la ropa","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":442.0098749999888,"c":2.3898e-05},{"k":"es","t":"ven aca","u":true,"v":"es","ask":"none","p":{"pt":0.02,"es":0.97,"en":0,"other":0.01},"ms":452.5965409999917,"c":2.3772e-05},{"k":"es","t":"ven aquí preciosa","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":462.8052080000052,"c":2.3856e-05},{"k":"es","t":"todo bien y tu","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":450.53595800000767,"c":2.3856e-05},{"k":"es","t":"todo bien","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":479.64845900000364,"c":2.3772e-05},{"k":"es","t":"vale tío","u":true,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":459.7331669999985,"c":2.3814e-05},{"k":"es","t":"dale","u":true,"v":"other","ask":"none","p":{"pt":0.04,"es":0.23,"en":0.26,"other":0.47},"ms":752.6812910000008,"c":2.3729999999999998e-05},{"k":"es","t":"en serio","u":true,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":452.1058750000084,"c":2.3772e-05},{"k":"es","t":"que hora es","u":false,"v":"es","ask":"none","p":{"pt":0.04,"es":0.96,"en":0,"other":0},"ms":457.1414999999979,"c":2.3814e-05},{"k":"es","t":"esta lloviendo","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":512.1784579999949,"c":2.3856e-05},{"k":"es","t":"donde vives","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":470.7654579999944,"c":2.3856e-05},{"k":"es","t":"confío en ti","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":469.73295799999323,"c":2.3856e-05},{"k":"es","t":"no confio en el","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":548.8562079999974,"c":2.3898e-05},{"k":"es","t":"te prometo que vuelvo","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":467.0765410000022,"c":2.3982e-05},{"k":"es","t":"te lo juro","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":460.0329589999892,"c":2.3856e-05},{"k":"es","t":"nada","u":true,"v":"es","ask":"none","p":{"pt":0.02,"es":0.65,"en":0,"other":0.33},"ms":462.68787500000326,"c":2.3772e-05},{"k":"es","t":"nada importante","u":false,"v":"es","ask":"none","p":{"pt":0.05,"es":0.88,"en":0,"other":0.07},"ms":462.3114579999965,"c":2.3814e-05},{"k":"es","t":"sigue","u":true,"v":"es","ask":"none","p":{"pt":0.01,"es":0.97,"en":0,"other":0.02},"ms":464.57037500001024,"c":2.3772e-05},{"k":"es","t":"sigue con la historia","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":449.4037499999977,"c":2.3898e-05},{"k":"es","t":"cambia de tema","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":460.7342079999944,"c":2.3898e-05},{"k":"es","t":"es un sueño?","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":447.7350000000006,"c":2.3856e-05},{"k":"es","t":"estoy muerto?","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":480.00362499999756,"c":2.3856e-05},{"k":"es","t":"estoy perdido","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":449.9503330000007,"c":2.3814e-05},{"k":"es","t":"quiero saber la verdad","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":451.74575000000186,"c":2.3898e-05},{"k":"es","t":"dime la verdad","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":448.24020899999596,"c":2.3856e-05},{"k":"es","t":"quiero ver el mar","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":454.88933399999223,"c":2.3898e-05},{"k":"es","t":"yo tambien","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":446.5682080000115,"c":2.3772e-05},{"k":"es","t":"yo también te quiero","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":456.9915420000034,"c":2.3856e-05},{"k":"es","t":"genial","u":true,"v":"es","ask":"none","p":{"pt":0.03,"es":0.81,"en":0,"other":0.16},"ms":447.7882499999978,"c":2.3772e-05},{"k":"es","t":"que bueno esta esto","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":450.4181660000031,"c":2.3856e-05},{"k":"es","t":"qué historia más increíble, sigue","u":false,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":460.2318340000056,"c":2.3939999999999998e-05},{"k":"es","t":"che boludo que haces","u":true,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":466.45824999999604,"c":2.3898e-05},{"k":"es","t":"vos quien sos","u":false,"v":"es","ask":"none","p":{"pt":0.01,"es":0.99,"en":0,"other":0},"ms":444.546583000003,"c":2.3814e-05},{"k":"es","t":"órale güey","u":true,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":494.8572920000006,"c":2.3898e-05},{"k":"en","t":"hola Marcelo, I missed you","u":false,"v":"en","ask":"none","p":{"pt":0,"es":0.13,"en":0.59,"other":0.28},"ms":465.8944999999949,"c":2.3939999999999998e-05},{"k":"en","t":"Sol, Luz, come here","u":false,"v":"en","ask":"none","p":{"pt":0.01,"es":0.07,"en":0.91,"other":0.01},"ms":473.33995799999684,"c":2.3939999999999998e-05},{"k":"en","t":"I look at Mateo and Rosa","u":false,"v":"en","ask":"none","p":{"pt":0,"es":0,"en":1,"other":0},"ms":446.77029200000106,"c":2.3939999999999998e-05},{"k":"en","t":"Elena, la casa is beautiful","u":false,"v":"en","ask":"none","p":{"pt":0,"es":0.02,"en":0.98,"other":0},"ms":454.9802919999929,"c":2.3982e-05},{"k":"en","t":"Amor, come to me","u":true,"v":"en","ask":"none","p":{"pt":0.23,"es":0.18,"en":0.5,"other":0.09},"ms":443.68783399999666,"c":2.3939999999999998e-05},{"k":"en","t":"adios amigo, see you later","u":true,"v":"en","ask":"none","p":{"pt":0,"es":0.11,"en":0.72,"other":0.17},"ms":471.72925000000396,"c":2.3982e-05},{"k":"en","t":"mi casa is your casa lol","u":true,"v":"en","ask":"none","p":{"pt":0,"es":0.03,"en":0.97,"other":0},"ms":468.66366600000765,"c":2.3939999999999998e-05},{"k":"en","t":"señorita please","u":true,"v":"en","ask":"none","p":{"pt":0,"es":0.46,"en":0.51,"other":0.03},"ms":467.0080420000013,"c":2.3898e-05},{"k":"en","t":"te amo, she whispers, and I smile","u":false,"v":"en","ask":"none","p":{"pt":0.01,"es":0.32,"en":0.65,"other":0.02},"ms":464.64274999999907,"c":2.4066e-05},{"k":"en","t":"no se","u":true,"v":"es","ask":"none","p":{"pt":0.01,"es":0.97,"en":0,"other":0.02},"ms":461.0188749999943,"c":2.3772e-05},{"k":"en","t":"que?","u":true,"v":"es","ask":"none","p":{"pt":0.1,"es":0.47,"en":0,"other":0.43},"ms":445.7690419999999,"c":2.3772e-05},{"k":"en","t":"I say \"hola\" to the baker","u":false,"v":"en","ask":"none","p":{"pt":0,"es":0,"en":1,"other":0},"ms":453.41745799999626,"c":2.4024e-05},{"k":"en","t":"Continue","u":true,"v":"en","ask":"none","p":{"pt":0,"es":0,"en":0.97,"other":0.03},"ms":471.9189999999944,"c":2.3729999999999998e-05},{"k":"en","t":"no","u":true,"v":"en","ask":"none","p":{"pt":0,"es":0,"en":0.74,"other":0.26},"ms":461.68666599999415,"c":2.3729999999999998e-05},{"k":"en","t":"no no no","u":true,"v":"en","ask":"none","p":{"pt":0,"es":0,"en":0.8,"other":0.2},"ms":449.1653329999972,"c":2.3814e-05},{"k":"en","t":"come","u":true,"v":"en","ask":"none","p":{"pt":0,"es":0.01,"en":0.91,"other":0.08},"ms":463.7041659999959,"c":2.3729999999999998e-05},{"k":"en","t":"me","u":true,"v":"en","ask":"none","p":{"pt":0.01,"es":0.02,"en":0.8,"other":0.17},"ms":490.75350000000617,"c":2.3729999999999998e-05},{"k":"en","t":"u","u":true,"v":"other","ask":"none","p":{"pt":0.02,"es":0.03,"en":0.33,"other":0.62},"ms":455.05129200000374,"c":2.3729999999999998e-05},{"k":"en","t":"ok","u":true,"v":"en","ask":"none","p":{"pt":0,"es":0,"en":0.94,"other":0.06},"ms":448.4068330000009,"c":2.3729999999999998e-05},{"k":"en","t":"hi","u":true,"v":"en","ask":"none","p":{"pt":0,"es":0,"en":0.99,"other":0.01},"ms":472.078416999997,"c":2.3729999999999998e-05},{"k":"en","t":"hello","u":true,"v":"en","ask":"none","p":{"pt":0,"es":0,"en":1,"other":0},"ms":447.4986249999929,"c":2.3729999999999998e-05},{"k":"en","t":"Marigold","u":true,"v":"other","ask":"none","p":{"pt":0,"es":0,"en":0.26,"other":0.74},"ms":523.5917499999923,"c":2.3814e-05},{"k":"en","t":"Salvador","u":true,"v":"other","ask":"none","p":{"pt":0,"es":0.03,"en":0.01,"other":0.96},"ms":467.1273329999967,"c":2.3814e-05},{"k":"en","t":"hey Paloma","u":true,"v":"en","ask":"none","p":{"pt":0,"es":0,"en":1,"other":0},"ms":469.4904999999999,"c":2.3814e-05},{"k":"en","t":"bro what","u":true,"v":"en","ask":"none","p":{"pt":0,"es":0,"en":1,"other":0},"ms":716.5532499999972,"c":2.3772e-05},{"k":"en","t":"wtf","u":true,"v":"en","ask":"none","p":{"pt":0,"es":0,"en":0.94,"other":0.06},"ms":462.77079100000265,"c":2.3772e-05},{"k":"en","t":"idk","u":true,"v":"en","ask":"none","p":{"pt":0,"es":0,"en":0.98,"other":0.02},"ms":460.26258300000336,"c":2.3772e-05},{"k":"en","t":"nah im good","u":true,"v":"en","ask":"none","p":{"pt":0,"es":0,"en":1,"other":0},"ms":475.04725000000326,"c":2.3814e-05},{"k":"en","t":"Do it.","u":false,"v":"en","ask":"none","p":{"pt":0,"es":0,"en":1,"other":0},"ms":446.8394580000022,"c":2.3814e-05},{"k":"en","t":"lol","u":true,"v":"other","ask":"none","p":{"pt":0,"es":0,"en":0.08,"other":0.92},"ms":459.7945830000099,"c":2.3729999999999998e-05},{"k":"en","t":"hmm","u":true,"v":"other","ask":"none","p":{"pt":0,"es":0,"en":0.02,"other":0.98},"ms":619.5679580000001,"c":2.3772e-05},{"k":"en","t":"where r u","u":false,"v":"en","ask":"none","p":{"pt":0,"es":0,"en":1,"other":0},"ms":867.584875,"c":2.3814e-05},{"k":"en","t":"sure","u":true,"v":"en","ask":"none","p":{"pt":0,"es":0,"en":0.99,"other":0.01},"ms":470.9630830000001,"c":2.3729999999999998e-05},{"k":"en","t":"more","u":true,"v":"en","ask":"none","p":{"pt":0,"es":0,"en":0.86,"other":0.14},"ms":431.18837499999995,"c":2.3729999999999998e-05},{"k":"en","t":"real","u":true,"v":"en","ask":"none","p":{"pt":0.02,"es":0.03,"en":0.59,"other":0.36},"ms":536.062584,"c":2.3729999999999998e-05},{"k":"en","t":"general","u":true,"v":"en","ask":"none","p":{"pt":0,"es":0,"en":0.87,"other":0.13},"ms":469.6968340000001,"c":2.3729999999999998e-05},{"k":"en","t":"formal","u":true,"v":"en","ask":"none","p":{"pt":0.01,"es":0,"en":0.81,"other":0.18},"ms":453.77308300000004,"c":2.3772e-05},{"k":"en","t":"fatal","u":true,"v":"en","ask":"none","p":{"pt":0.01,"es":0.01,"en":0.78,"other":0.2},"ms":494.2082090000001,"c":2.3729999999999998e-05},{"k":"en","t":"total","u":true,"v":"en","ask":"none","p":{"pt":0.02,"es":0.02,"en":0.68,"other":0.28},"ms":465.45162500000015,"c":2.3729999999999998e-05},{"k":"en","t":"animal","u":true,"v":"en","ask":"none","p":{"pt":0.01,"es":0.01,"en":0.88,"other":0.1},"ms":430.2237500000001,"c":2.3729999999999998e-05},{"k":"en","t":"idea","u":true,"v":"en","ask":"none","p":{"pt":0,"es":0.01,"en":0.85,"other":0.14},"ms":454.26145799999995,"c":2.3729999999999998e-05},{"k":"en","t":"final","u":true,"v":"en","ask":"none","p":{"pt":0.03,"es":0.03,"en":0.62,"other":0.32},"ms":431.408042,"c":2.3729999999999998e-05},{"k":"en","t":"normal","u":true,"v":"en","ask":"none","p":{"pt":0,"es":0,"en":0.52,"other":0.48},"ms":498.031375,"c":2.3729999999999998e-05},{"k":"en","t":"no idea","u":true,"v":"en","ask":"none","p":{"pt":0,"es":0,"en":1,"other":0},"ms":442.6082080000001,"c":2.3772e-05},{"k":"en","t":"a real idea","u":true,"v":"en","ask":"none","p":{"pt":0,"es":0,"en":1,"other":0},"ms":455.902959,"c":2.3814e-05},{"k":"en","t":"per favor sir","u":true,"v":"es","ask":"none","p":{"pt":0.19,"es":0.66,"en":0.04,"other":0.11},"ms":471.3837500000004,"c":2.3814e-05},{"k":"en","t":"grab a taco","u":true,"v":"en","ask":"none","p":{"pt":0,"es":0,"en":1,"other":0},"ms":454.4758329999995,"c":2.3814e-05},{"k":"en","t":"go to Rio","u":false,"v":"en","ask":"none","p":{"pt":0,"es":0,"en":1,"other":0},"ms":463.2468339999996,"c":2.3814e-05},{"k":"en","t":"in Santa Maria","u":true,"v":"en","ask":"none","p":{"pt":0.02,"es":0.02,"en":0.9,"other":0.06},"ms":462.0301669999999,"c":2.3814e-05},{"k":"en","t":"Elena no","u":true,"v":"es","ask":"none","p":{"pt":0.02,"es":0.75,"en":0.05,"other":0.18},"ms":445.0197909999997,"c":2.3814e-05},{"k":"en","t":"Come on Elena","u":false,"v":"en","ask":"none","p":{"pt":0,"es":0,"en":1,"other":0},"ms":458.87695800000074,"c":2.3814e-05},{"k":"en","t":"do tell","u":false,"v":"en","ask":"none","p":{"pt":0,"es":0,"en":0.99,"other":0.01},"ms":447.82708300000013,"c":2.3772e-05},{"k":"en","t":"casa","u":true,"v":"other","ask":"none","p":{"pt":0.07,"es":0.17,"en":0,"other":0.76},"ms":472.43216699999994,"c":2.3772e-05},{"k":"en","t":"vista","u":true,"v":"other","ask":"none","p":{"pt":0.05,"es":0.31,"en":0,"other":0.64},"ms":481.25774999999976,"c":2.3729999999999998e-05},{"k":"en","t":"a la carte","u":true,"v":"en","ask":"none","p":{"pt":0.01,"es":0.01,"en":0.9,"other":0.08},"ms":504.9560840000004,"c":2.3814e-05},{"k":"en","t":"I am so done","u":false,"v":"en","ask":"none","p":{"pt":0,"es":0,"en":1,"other":0},"ms":439.5144170000003,"c":2.3856e-05},{"k":"en","t":"me so sad","u":false,"v":"en","ask":"none","p":{"pt":0,"es":0.01,"en":0.99,"other":0},"ms":442.3493749999998,"c":2.3814e-05},{"k":"en","t":"do as I say","u":false,"v":"en","ask":"none","p":{"pt":0,"es":0,"en":1,"other":0},"ms":459.45229199999994,"c":2.3856e-05},{"k":"en","t":"as if","u":false,"v":"en","ask":"none","p":{"pt":0,"es":0,"en":0.98,"other":0.02},"ms":467.9574590000002,"c":2.3772e-05},{"k":"en","t":"no more","u":false,"v":"en","ask":"none","p":{"pt":0,"es":0,"en":0.99,"other":0.01},"ms":444.93925000000036,"c":2.3772e-05},{"k":"other","t":"Je suis perdu","u":true,"v":"other","ask":"none","p":{"pt":0,"es":0,"en":0,"other":1},"ms":438.51629200000025,"c":2.3814e-05},{"k":"en","t":"nos vemos","u":true,"v":"es","ask":"none","p":{"pt":0,"es":1,"en":0,"other":0},"ms":453.66395900000043,"c":2.3772e-05},{"k":"other","t":"où suis-je","u":true,"v":"other","ask":"none","p":{"pt":0,"es":0,"en":0,"other":1},"ms":478.1135829999994,"c":2.3814e-05},{"k":"other","t":"bonjour tu vas bien","u":true,"v":"other","ask":"none","p":{"pt":0,"es":0,"en":0,"other":1},"ms":469.9506250000004,"c":2.3898e-05},{"k":"other","t":"qui es tu","u":true,"v":"other","ask":"none","p":{"pt":0,"es":0,"en":0,"other":1},"ms":603.4104169999991,"c":2.3814e-05},{"k":"other","t":"je t'aime","u":true,"v":"other","ask":"none","p":{"pt":0,"es":0,"en":0,"other":1},"ms":619.0943750000006,"c":2.3856e-05},{"k":"other","t":"j'ai faim","u":true,"v":"other","ask":"none","p":{"pt":0,"es":0,"en":0,"other":1},"ms":441.78070800000023,"c":2.3856e-05},{"k":"other","t":"aide moi s'il te plait","u":true,"v":"other","ask":"none","p":{"pt":0,"es":0,"en":0,"other":1},"ms":475.6029589999998,"c":2.4024e-05},{"k":"other","t":"on va où","u":true,"v":"other","ask":"none","p":{"pt":0,"es":0,"en":0,"other":1},"ms":436.46879199999967,"c":2.3814e-05},{"k":"other","t":"je la regarde","u":true,"v":"other","ask":"none","p":{"pt":0,"es":0.01,"en":0,"other":0.99},"ms":447.1254590000008,"c":2.3814e-05},{"k":"other","t":"ciao","u":true,"v":"other","ask":"none","p":{"pt":0,"es":0.01,"en":0,"other":0.99},"ms":518.366,"c":2.3772e-05},{"k":"other","t":"dove sono","u":true,"v":"other","ask":"none","p":{"pt":0,"es":0.01,"en":0,"other":0.99},"ms":511.0765420000007,"c":2.3814e-05},{"k":"other","t":"chi sei","u":true,"v":"other","ask":"none","p":{"pt":0,"es":0.01,"en":0,"other":0.99},"ms":457.12233300000116,"c":2.3772e-05},{"k":"other","t":"come stai","u":true,"v":"other","ask":"none","p":{"pt":0,"es":0,"en":0,"other":1},"ms":442.408707999999,"c":2.3814e-05},{"k":"other","t":"non capisco","u":true,"v":"other","ask":"none","p":{"pt":0,"es":0,"en":0,"other":1},"ms":433.18483300000116,"c":2.3814e-05},{"k":"other","t":"ho fame","u":true,"v":"other","ask":"none","p":{"pt":0.26,"es":0.21,"en":0.01,"other":0.52},"ms":448.5968330000014,"c":2.3772e-05},{"k":"other","t":"ti amo","u":true,"v":"other","ask":"none","p":{"pt":0,"es":0.01,"en":0,"other":0.99},"ms":442.8309169999993,"c":2.3772e-05},{"k":"other","t":"mi alzo lentamente","u":true,"v":"es","ask":"none","p":{"pt":0.03,"es":0.97,"en":0,"other":0},"ms":452.24270799999977,"c":2.3856e-05},{"k":"other","t":"andiamo via","u":true,"v":"other","ask":"none","p":{"pt":0,"es":0,"en":0,"other":1},"ms":443.3512500000015,"c":2.3814e-05},{"k":"other","t":"la bacio","u":false,"v":"other","ask":"none","p":{"pt":0.01,"es":0.03,"en":0,"other":0.96},"ms":479.6359590000011,"c":2.3814e-05},{"k":"other","t":"ich bin müde","u":true,"v":"other","ask":"none","p":{"pt":0,"es":0,"en":0,"other":1},"ms":429.7687499999993,"c":2.3898e-05},{"k":"other","t":"sono stanco","u":true,"v":"other","ask":"none","p":{"pt":0,"es":0.01,"en":0,"other":0.99},"ms":450.50383299999885,"c":2.3814e-05},{"k":"other","t":"wo bin ich","u":true,"v":"other","ask":"none","p":{"pt":0,"es":0,"en":0,"other":1},"ms":447.11462500000016,"c":2.3814e-05},{"k":"other","t":"wer bist du","u":true,"v":"other","ask":"none","p":{"pt":0,"es":0,"en":0,"other":1},"ms":447.7686670000003,"c":2.3814e-05},{"k":"other","t":"hilf mir bitte","u":true,"v":"other","ask":"none","p":{"pt":0,"es":0,"en":0,"other":1},"ms":441.89970899999935,"c":2.3856e-05},{"k":"other","t":"ich liebe dich","u":true,"v":"other","ask":"none","p":{"pt":0,"es":0,"en":0,"other":1},"ms":447.82416700000067,"c":2.3814e-05},{"k":"other","t":"qui ets","u":true,"v":"other","ask":"none","p":{"pt":0,"es":0.01,"en":0,"other":0.99},"ms":443.83116599999994,"c":2.3772e-05},{"k":"other","t":"on sóc","u":true,"v":"other","ask":"none","p":{"pt":0.22,"es":0.16,"en":0.01,"other":0.61},"ms":466.1266660000001,"c":2.3772e-05},{"k":"other","t":"no entenc res","u":true,"v":"other","ask":"none","p":{"pt":0.04,"es":0.39,"en":0,"other":0.57},"ms":490.23641599999974,"c":2.3856e-05},{"k":"other","t":"tinc gana","u":true,"v":"other","ask":"none","p":{"pt":0,"es":0.44,"en":0,"other":0.56},"ms":469.143082999999,"c":2.3814e-05},{"k":"other","t":"t'estimo","u":true,"v":"other","ask":"none","p":{"pt":0.02,"es":0.08,"en":0,"other":0.9},"ms":482.26016700000037,"c":2.3814e-05},{"k":"other","t":"quen es ti","u":true,"v":"es","ask":"none","p":{"pt":0.02,"es":0.97,"en":0,"other":0.01},"ms":496.51579200000015,"c":2.3814e-05},{"k":"other","t":"onde estou eu agora meu ben","u":false,"v":"pt","ask":"none","p":{"pt":1,"es":0,"en":0,"other":0},"ms":461.1125000000011,"c":2.3939999999999998e-05},{"k":"other","t":"non entendo nada","u":true,"v":"pt","ask":"none","p":{"pt":0.98,"es":0.01,"en":0,"other":0.01},"ms":458.7077499999996,"c":2.3856e-05},{"k":"other","t":"teño fame","u":false,"v":"other","ask":"none","p":{"pt":0.01,"es":0.01,"en":0,"other":0.98},"ms":448.70158400000037,"c":2.3814e-05},{"k":"other","t":"quérote","u":true,"v":"es","ask":"none","p":{"pt":0.02,"es":0.97,"en":0,"other":0.01},"ms":455.6037500000002,"c":2.3814e-05},{"k":"other","t":"unde sunt","u":true,"v":"other","ask":"none","p":{"pt":0.11,"es":0.01,"en":0,"other":0.88},"ms":481.59458300000006,"c":2.3772e-05},{"k":"other","t":"cine esti","u":true,"v":"other","ask":"none","p":{"pt":0.04,"es":0.02,"en":0,"other":0.94},"ms":452.2339579999989,"c":2.3772e-05},{"k":"other","t":"te iubesc","u":true,"v":"other","ask":"none","p":{"pt":0,"es":0,"en":0,"other":1},"ms":466.0445830000008,"c":2.3856e-05},{"k":"other","t":"mi-e foame","u":true,"v":"other","ask":"none","p":{"pt":0.01,"es":0.01,"en":0,"other":0.98},"ms":457.3788749999985,"c":2.3856e-05},{"k":"other","t":"nu inteleg nimic","u":true,"v":"other","ask":"none","p":{"pt":0.01,"es":0,"en":0,"other":0.99},"ms":438.68070799999987,"c":2.3898e-05},{"k":"other","t":"nasaan ako","u":true,"v":"other","ask":"none","p":{"pt":0,"es":0,"en":0,"other":1},"ms":447.8622080000023,"c":2.3814e-05},{"k":"other","t":"gutom na ako","u":true,"v":"other","ask":"none","p":{"pt":0,"es":0,"en":0,"other":1},"ms":444.2045829999988,"c":2.3856e-05},{"k":"other","t":"mahal kita","u":true,"v":"other","ask":"none","p":{"pt":0,"es":0,"en":0,"other":1},"ms":465.3909999999996,"c":2.3814e-05},{"k":"other","t":"sino ka","u":true,"v":"other","ask":"none","p":{"pt":0,"es":0,"en":0,"other":1},"ms":460.19320799999696,"c":2.3814e-05},{"k":"other","t":"main kahan hoon","u":true,"v":"other","ask":"none","p":{"pt":0,"es":0,"en":0,"other":1},"ms":923.7048749999994,"c":2.3898e-05},{"k":"other","t":"kaun ho tum","u":true,"v":"other","ask":"none","p":{"pt":0,"es":0,"en":0,"other":1},"ms":925.4825410000012,"c":2.3856e-05},{"k":"other","t":"mujhe bhook lagi hai","u":true,"v":"other","ask":"none","p":{"pt":0,"es":0,"en":0,"other":1},"ms":454.88950000000114,"c":2.3982e-05},{"k":"other","t":"aku lapar","u":true,"v":"other","ask":"none","p":{"pt":0,"es":0,"en":0,"other":1},"ms":440.5136249999996,"c":2.3814e-05},{"k":"other","t":"tum kaisi ho","u":true,"v":"other","ask":"none","p":{"pt":0,"es":0,"en":0,"other":1},"ms":488.2212499999987,"c":2.3856e-05},{"k":"other","t":"siapa kamu","u":true,"v":"other","ask":"none","p":{"pt":0,"es":0,"en":0,"other":1},"ms":454.2950830000009,"c":2.3814e-05},{"k":"other","t":"dimana aku","u":true,"v":"other","ask":"none","p":{"pt":0,"es":0,"en":0,"other":1},"ms":455.7605000000003,"c":2.3814e-05},{"k":"other","t":"aku cinta kamu","u":true,"v":"other","ask":"none","p":{"pt":0,"es":0,"en":0,"other":1},"ms":445.1264999999985,"c":2.3814e-05},{"k":"other","t":"gdje sam","u":true,"v":"other","ask":"none","p":{"pt":0,"es":0,"en":0,"other":1},"ms":721.4810419999994,"c":2.3814e-05},{"k":"other","t":"tko si ti","u":true,"v":"other","ask":"none","p":{"pt":0.01,"es":0.03,"en":0,"other":0.96},"ms":463.83670899999925,"c":2.3856e-05},{"k":"other","t":"gladan sam","u":true,"v":"other","ask":"none","p":{"pt":0,"es":0,"en":0,"other":1},"ms":461.56445800000074,"c":2.3814e-05},{"k":"other","t":"kim sen","u":true,"v":"other","ask":"none","p":{"pt":0.09,"es":0.07,"en":0.02,"other":0.82},"ms":443.04566700000214,"c":2.3772e-05},{"k":"other","t":"neredeyim","u":true,"v":"other","ask":"none","p":{"pt":0,"es":0,"en":0,"other":1},"ms":458.6889999999985,"c":2.3856e-05},{"k":"other","t":"seni seviyorum","u":true,"v":"other","ask":"none","p":{"pt":0,"es":0,"en":0,"other":1},"ms":447.85499999999956,"c":2.3898e-05},{"k":"other","t":"wer ist da","u":true,"v":"other","ask":"none","p":{"pt":0,"es":0,"en":0,"other":1},"ms":454.70524999999907,"c":2.3814e-05},{"k":"other","t":"waar ben ik","u":true,"v":"other","ask":"none","p":{"pt":0,"es":0,"en":0,"other":1},"ms":465.52570800000103,"c":2.3814e-05}]

let pass = 0
let fail = 0
async function check(label: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    pass++
    console.log(`  ok   ${label}`)
  } catch (err) {
    fail++
    console.log(`  FAIL ${label}\n       ${(err as Error).message}`)
  }
}

/** The decisions endpoint's answer shape, as recorded. */
function decision(
  writtenIn: string,
  probability: unknown,
  asksFor = 'none',
  asksProbability: unknown = 1,
): unknown {
  return {
    answers: {
      written_in: {
        choice: writtenIn,
        probabilities: { [writtenIn]: probability },
      },
      asks_for: {
        choice: asksFor,
        probabilities: { [asksFor]: asksProbability },
      },
    },
  }
}

function replay(line: RecordedLine): ReplyLanguageCheckResult | null {
  return parseReplyLanguageDecision(
    {
      answers: {
        written_in: { choice: line.v, probabilities: line.p },
        asks_for: { choice: 'none', probabilities: { none: 1 } },
      },
    },
    ENTRIES,
  )
}

// ── 1. start of a save: the setting, then writing, then English ──────────────
await check('start of a save: setting, then writing memory, then English', () => {
  assert.equal(startingLanguage({ preference: 'en', written: 'pt', enabledCodes: ENABLED }), undefined)
  assert.equal(startingLanguage({ preference: 'es', written: 'pt', enabledCodes: ENABLED }), 'es')
  assert.equal(startingLanguage({ written: 'pt', enabledCodes: ENABLED }), 'pt')
  assert.equal(startingLanguage({ written: 'en', enabledCodes: ENABLED }), undefined)
})

// ── 2. the exact request, with the zdr pin ───────────────────────────────────
await check('exact request: model, zdr route, state and both questions', () => {
  const request = buildReplyLanguageRequest('  Olá, quero falar em espanhol.  ', ENTRIES, 'typesafe/jev-1.14')
  assert.deepEqual(request, {
    model: 'typesafe/jev-1.14',
    provider: { only: ['typesafe/zdr'] },
    state: { player_message: 'Olá, quero falar em espanhol.' },
    questions: {
      written_in: {
        type: 'choice',
        instructions:
          "Which language is the player's own message written in? It is one turn of an interactive story. Names of people and places do not decide the language. A short line or a greeting counts as the language it is written in when that is clear, spelled casually or without accents. Names alone, sounds (hmm, lol) and words that are equally normal in two of these languages are other.",
        criteria: {
          pt: 'Written in Brazilian Portuguese.',
          es: 'Written in Spanish.',
          en: 'Written in English, including English with a foreign name or word in it.',
          other: 'Another language, only a name or a sound, or a word equally normal in two of these languages.',
        },
      },
      asks_for: {
        type: 'choice',
        instructions: 'Which language is the player explicitly asking the story to be told in?',
        criteria: {
          pt: 'Asks for Brazilian Portuguese.',
          es: 'Asks for Spanish.',
          en: 'Asks for English.',
          none: 'Does not ask for a language. Mentioning a language, or a character speaking one, is not asking.',
        },
      },
    },
  })
  assert.equal(
    buildReplyLanguageRequest('oi', ENTRIES).model,
    process.env.MODEL_REPLY_LANGUAGE || 'typesafe/jev-1.14',
  )
  assert.equal(buildReplyLanguageRequest('x'.repeat(2500), ENTRIES).state.player_message.length, 2000)
})

// ── 3. the 0.9 floor and exactly which values count ──────────────────────────
await check('0.9 floor: 0.8999 no, 0.9 yes, 1 yes, NaN/missing/string no', () => {
  assert.equal(MIN_DECISION_PROBABILITY, 0.9)
  assert.equal(parseReplyLanguageDecision(decision('pt', 0.8999), ENTRIES)?.written_in, 'other')
  assert.equal(parseReplyLanguageDecision(decision('pt', 0.9), ENTRIES)?.written_in, 'pt')
  assert.equal(parseReplyLanguageDecision(decision('pt', 1), ENTRIES)?.written_in, 'pt')
  assert.equal(parseReplyLanguageDecision(decision('pt', Number.NaN), ENTRIES)?.written_in, 'other')
  assert.equal(parseReplyLanguageDecision(decision('pt', '0.95'), ENTRIES)?.written_in, 'other')
  assert.equal(
    parseReplyLanguageDecision(
      { answers: { written_in: { choice: 'pt', probabilities: {} }, asks_for: { choice: 'none', probabilities: { none: 1 } } } },
      ENTRIES,
    )?.written_in,
    'other',
  )
  // asks_for uses the same floor, and "none" is never a request.
  assert.equal(parseReplyLanguageDecision(decision('en', 1, 'es', 0.8999), ENTRIES)?.asks_for, null)
  assert.equal(parseReplyLanguageDecision(decision('en', 1, 'es', 0.9), ENTRIES)?.asks_for, 'es')
  assert.equal(parseReplyLanguageDecision(decision('en', 1, 'none', 1), ENTRIES)?.asks_for, null)
})

// ── 4. unknown and disabled codes ────────────────────────────────────────────
await check('codes: unknown and disabled are other / no request', () => {
  assert.deepEqual(parseReplyLanguageDecision(decision('fr', 1), ENTRIES), {
    written_in: 'other',
    asks_for: null,
  })
  // pt is off, so the same answer is not allowed.
  assert.deepEqual(parseReplyLanguageDecision(decision('pt', 1), [ES]), {
    written_in: 'other',
    asks_for: null,
  })
  assert.deepEqual(parseReplyLanguageDecision(decision('en', 1, 'pt', 1), [ES]), {
    written_in: 'en',
    asks_for: null,
  })
})

// ── 5. every malformed shape is null, never a guessed answer ─────────────────
await check('malformed: null on a bad shape or a missing question', () => {
  const malformed: unknown[] = [
    null,
    undefined,
    'x',
    7,
    [],
    {},
    { answers: null },
    { answers: 'x' },
    { answers: {} },
    { answers: { written_in: { choice: 'pt', probabilities: { pt: 1 } } } },
    { answers: { asks_for: { choice: 'none', probabilities: { none: 1 } } } },
    { answers: { written_in: null, asks_for: { choice: 'none', probabilities: { none: 1 } } } },
    { answers: { written_in: { choice: 'pt', probabilities: { pt: 1 } }, asks_for: 'none' } },
  ]
  for (const raw of malformed) assert.equal(parseReplyLanguageDecision(raw, ENTRIES), null)
  // A present question with an unusable choice is a choice, not a failure.
  assert.deepEqual(
    parseReplyLanguageDecision(
      { answers: { written_in: { choice: 'pt' }, asks_for: { choice: 'none', probabilities: { none: 1 } } } },
      ENTRIES,
    ),
    { written_in: 'other', asks_for: null },
  )
})

// ── 6. non-200, timeout, abort and one attempt ───────────────────────────────
await check('transport: non-200 is null and there is one attempt', async () => {
  let calls = 0
  const transport: ReplyLanguageTransport = async () => {
    calls++
    return { status: 500, body: decision('pt', 1) }
  }
  assert.equal(await checkReplyLanguage('oi', { enabledCodes: ENABLED, transport }), null)
  assert.equal(calls, 1)
})

await check('transport: over 2 s is null (default is 2000 ms)', async () => {
  const never: ReplyLanguageTransport = () => new Promise<ReplyLanguageHttpResponse>(() => {})
  const started = performance.now()
  const result = await checkReplyLanguage('oi', { enabledCodes: ENABLED, transport: never, timeoutMs: 40 })
  const elapsed = performance.now() - started
  assert.equal(result, null)
  assert.equal(DECISION_TIMEOUT_MS, 2000)
  assert.ok(elapsed >= 20 && elapsed < 1000, `timed out in ${Math.round(elapsed)} ms`)
})

await check('transport: aborting the turn is null at once', async () => {
  const never: ReplyLanguageTransport = () => new Promise<ReplyLanguageHttpResponse>(() => {})
  const controller = new AbortController()
  const started = performance.now()
  const pending = checkReplyLanguage('oi', {
    enabledCodes: ENABLED,
    transport: never,
    signal: controller.signal,
  })
  controller.abort()
  assert.equal(await pending, null)
  assert.ok(performance.now() - started < 300, 'the abort did not cut the request')
})

// ── 7. the player's text is never logged; usage uses the shared path ─────────
await check('privacy and usage: no log line carries the text; usage path is shared', async () => {
  const source = await readFile(new URL('../worker/lib/reply-language-check.ts', import.meta.url), 'utf8')
  assert.ok(!/console\.(log|info|warn|error)/.test(source), 'the detector logs')
  assert.ok(source.includes('messages: []'), 'the trace must not carry the player text')
  assert.ok(source.includes('beginLLMTrace(') && source.includes('recordLLMUsage('))
  assert.ok(source.includes("purpose: 'reply_language_check'"))
})

// ── 8. pickup gate: what is known before the packet loads ───────────────────
await check('gate at pickup: truth table', () => {
  const base = {
    enabledCodes: ENABLED,
    isTyped: true,
    source: 'writing' as string | undefined,
    checks: 0,
    text: 'Olá, como você está?',
  }
  assert.equal(shouldStartReplyLanguageCheck({ ...base, enabledCodes: [] }), false)
  assert.equal(shouldStartReplyLanguageCheck(base), true)
  assert.equal(shouldStartReplyLanguageCheck({ ...base, isTyped: false }), false)
  assert.equal(shouldStartReplyLanguageCheck({ ...base, source: 'player' }), false)
  assert.equal(shouldStartReplyLanguageCheck({ ...base, text: '   ' }), false)
  assert.equal(shouldStartReplyLanguageCheck({ ...base, checks: 3, text: 'The room is quiet.' }), false)
  assert.equal(shouldStartReplyLanguageCheck({ ...base, checks: 3, text: 'Olá.' }), true)
})

// ── 9. after the packet: the offered chip test ──────────────────────────────
await check('chip test: a tapped chip is recognised from send or label', () => {
  const offered = [{ send: '*take his hand*', label: 'Take his hand.' }]
  assert.equal(matchesOfferedChip('Take his hand.', offered), true)
  assert.equal(matchesOfferedChip('take his hand', offered), true)
  assert.equal(matchesOfferedChip('I take his hand', offered), false)
  assert.equal(matchesOfferedChip('Take his hand.', []), false)
})

await check('tapped chip: the answer and the count are discarded', async () => {
  let calls = 0
  const stuck: ReplyLanguageTransport = (_request, signal) =>
    new Promise((_resolve, reject) => {
      calls++
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
  const check = startReplyLanguageCheck(
    { enabledCodes: ENABLED, isTyped: true, checks: 0, text: 'Take his hand.' },
    { enabledCodes: ENABLED, transport: stuck },
  )
  assert.equal(check.isOfferedChip([{ send: '*take his hand*', label: 'Take his hand.' }]), true)
  check.discard()
  assert.equal(check.discarded(), true)
  assert.equal(await check.promise, null)
  assert.equal(check.waitMs(1000, 1000), 0)
  assert.equal(calls, 1)
})

// ── 10. the first typed turn: same-turn use and the 700 ms ceiling ───────────
await check('same-turn: a result already in needs no wait and applies now', async () => {
  const transport: ReplyLanguageTransport = async () => ({ status: 200, body: decision('pt', 1) })
  const check = startReplyLanguageCheck(
    { enabledCodes: ENABLED, isTyped: true, checks: 0, text: 'oi' },
    { enabledCodes: ENABLED, transport },
  )
  assert.equal(check.started, true)
  await check.promise
  assert.equal(check.settled(), true)
  assert.equal(check.result()?.written_in, 'pt')
  assert.equal(check.waitMs(1000, 1000), 0)
})

await check('wait: 700 ms ceiling on the first typed turn only, at most once', async () => {
  let now = 1000
  const sleeps: number[] = []
  const stuck: ReplyLanguageTransport = () => new Promise<ReplyLanguageHttpResponse>(() => {})
  const first = startReplyLanguageCheck(
    { enabledCodes: ENABLED, isTyped: true, checks: 0, text: 'oi' },
    { enabledCodes: ENABLED, transport: stuck, now: () => now, sleep: async (ms) => { sleeps.push(ms) } },
  )
  assert.equal(REPLY_LANGUAGE_WAIT_MS, 700)
  assert.equal(first.waitMs(1000, 1000), 700)
  assert.equal(first.waitMs(1000, 1400), 300)
  assert.equal(first.waitMs(1000, 2000), 0)
  now = 1000
  await first.waitAtPrompt(1000)
  await first.waitAtPrompt(1000)
  assert.deepEqual(sleeps, [700], 'a never-returning check must cost 700 ms once')
  assert.ok(sleeps.every((ms) => ms <= 700))
  first.cancel()

  // Turn 2 (checks > 0) never waits, even with a check that never returns.
  now = 1000
  const sleeps2: number[] = []
  const second = startReplyLanguageCheck(
    { enabledCodes: ENABLED, isTyped: true, checks: 1, text: 'oi' },
    { enabledCodes: ENABLED, transport: stuck, now: () => now, sleep: async (ms) => { sleeps2.push(ms) } },
  )
  assert.equal(second.started, true)
  assert.equal(second.waitMs(1000, 1000), 0)
  assert.equal(replyLanguageWaitMs({ checks: 1, settled: false, discarded: false, prepEndedAt: 1000, now: 1000 }), 0)
  await second.waitAtPrompt(1000)
  assert.deepEqual(sleeps2, [])
  second.cancel()
})

await check('wait: a settled or discarded result is never waited for', () => {
  assert.equal(replyLanguageWaitMs({ checks: 0, settled: true, discarded: false, prepEndedAt: 1000, now: 1000 }), 0)
  assert.equal(replyLanguageWaitMs({ checks: 0, settled: false, discarded: true, prepEndedAt: 1000, now: 1000 }), 0)
})

// ── 11. off = no request, no wait ────────────────────────────────────────────
await check('off: no request is made and nothing waits', async () => {
  let calls = 0
  const transport: ReplyLanguageTransport = async () => {
    calls++
    return { status: 200, body: decision('pt', 1) }
  }
  const check = startReplyLanguageCheck(
    { enabledCodes: [], isTyped: true, checks: 0, text: 'oi' },
    { enabledCodes: [], transport },
  )
  assert.equal(check.started, false)
  assert.equal(await check.promise, null)
  assert.equal(check.waitMs(0, 0), 0)
  assert.equal(await checkReplyLanguage('oi', { enabledCodes: [], transport }), null)
  assert.equal(calls, 0)
})

// ── 12. the processor wiring at the numbered contract points ─────────────────
await check('processor: pickup start, packet chip test, prompt wait and same-turn apply', async () => {
  const source = await readFile(new URL('../worker/processors/generation.processor.ts', import.meta.url), 'utf8')
  const intent = source.indexOf('const intentRouter = startIntentRouter')
  const start = source.indexOf('const replyLanguageCheck = startReplyLanguageCheck')
  const packet = source.indexOf('const packet = await buildContextPacket')
  const chip = source.indexOf('if (replyLanguageCheck.isOfferedChip(offered))')
  const wait = source.indexOf('await replyLanguageCheck.waitAtPrompt(replyLanguagePrepEndedAt)')
  const applyNow = source.indexOf('if (replyLanguageCheck.settled() && !replyLanguageCheck.discarded() && !replyLanguageApplied)')
  const prompt = source.indexOf('const prompt = buildPrompt')
  assert.ok(intent > 0 && start > intent, 'the check must start at pickup beside the adult check')
  assert.ok(packet > start && chip > packet, 'the chip test must run after the packet loads')
  assert.ok(wait > packet && prompt > wait, 'the wait must be at the prompt, after prep')
  assert.ok(applyNow > wait && prompt > applyNow, 'a same-turn result must apply before the prompt')
  const streamEnd = source.indexOf('const streamEndedAt = Date.now()')
  const lateApply = source.indexOf('const replyLanguageApply')
  assert.ok(streamEnd > 0 && lateApply > streamEnd, 'a late result must apply after the stream')
  assert.ok(source.includes('await replyLanguageApply'))
})

await check('processor: the adult check is untouched and neither waits for the other', async () => {
  const source = await readFile(new URL('../worker/processors/generation.processor.ts', import.meta.url), 'utf8')
  assert.ok(source.includes('const intentRouter = startIntentRouter'))
  assert.ok(source.includes('decideIntentRoute('))
  assert.ok(!source.includes('intentRouter.wait('), 'the language check must not wait on the adult check')
  assert.ok(source.indexOf('const replyLanguageCheck = startReplyLanguageCheck') > source.indexOf('const intentRouter = startIntentRouter'))
})

// ── 13. the recorded corpus replay ───────────────────────────────────────────
await check('replay: 271 right, 0 wrong, 23 unclear on the 294 pt/es lines', () => {
  assert.equal(RECORDED.some((line) => line.k === 'real'), false, 'the corpus must be synthetic only')
  assert.equal(RECORDED.length, 415)
  const lines = RECORDED.filter((line) => line.k === 'pt' || line.k === 'es')
  assert.equal(lines.length, 294)
  let right = 0
  let wrong = 0
  let unclear = 0
  for (const line of lines) {
    const parsed = replay(line)
    assert.ok(parsed)
    if (parsed.written_in === line.k) right++
    else if (parsed.written_in === 'other') unclear++
    else wrong++
  }
  assert.deepEqual({ right, wrong, unclear }, { right: 271, wrong: 0, unclear: 23 })
})

await check('replay: 2 of 61 English traps and 5 of 60 other-language lines', () => {
  const english = RECORDED.filter((line) => line.k === 'en')
  const other = RECORDED.filter((line) => line.k === 'other')
  assert.equal(english.length, 61)
  assert.equal(other.length, 60)
  const calledPtOrEs = (line: RecordedLine) => {
    const parsed = replay(line)
    return parsed?.written_in === 'pt' || parsed?.written_in === 'es'
  }
  assert.equal(english.filter(calledPtOrEs).length, 2)
  assert.equal(other.filter(calledPtOrEs).length, 5)
})

if (fail > 0) {
  console.log(`\nreply-language detect audit: ${pass} passed, ${fail} failed`)
  process.exit(1)
}

if (process.argv.includes('--bites')) {
  await runBites()
} else {
  console.log(`\nreply-language detect audit: ${pass} passed, 0 failed`)
}

// ── bites ────────────────────────────────────────────────────────────────────
type Edit = [file: string, from: string, to: string]
type Mutation = { name: string; check: string; edits: Edit[] }

async function runBites() {
  const root = await mkdtemp(join(import.meta.dir, '.reply-language-detect-bites-'))
  const server = new URL('..', import.meta.url).pathname
  const AUDIT = 'scripts/reply-language-detect-audit.ts'

  const detector = 'worker/lib/reply-language-check.ts'
  const processor = 'worker/processors/generation.processor.ts'
  const replyLanguage = 'src/utils/reply-language.ts'

  const mutations: Mutation[] = [
    {
      name: 'request: the zdr route pin is dropped',
      check: 'exact request: model, zdr route, state and both questions',
      edits: [[detector, "provider: { only: ['typesafe/zdr'] },", 'provider: { only: [] },']],
    },
    {
      name: 'floor: any probability counts',
      check: '0.9 floor: 0.8999 no, 0.9 yes, 1 yes, NaN/missing/string no',
      edits: [[detector, 'return probability >= MIN_DECISION_PROBABILITY ? choice : null', 'return probability >= 0 ? choice : null']],
    },
    {
      name: 'codes: an unknown code is allowed',
      check: 'codes: unknown and disabled are other / no request',
      edits: [[detector, "const writtenAllowed = new Set([...codes, 'en', 'other'])", "const writtenAllowed = new Set([...codes, 'en', 'other', 'fr'])"]],
    },
    {
      name: 'shape: a missing question is read as an answer',
      check: 'malformed: null on a bad shape or a missing question',
      edits: [[detector, 'if (!isRecord(answers.written_in) || !isRecord(answers.asks_for)) return null', 'if (!isRecord(answers.written_in)) return null']],
    },
    {
      name: 'transport: a non-200 is accepted',
      check: 'transport: non-200 is null and there is one attempt',
      edits: [[detector, 'if (!response || response.status !== 200) return null', 'if (!response) return null']],
    },
    {
      name: 'timeout: the 2 s timer fires at once',
      check: 'transport: over 2 s is null (default is 2000 ms)',
      edits: [[detector, '    }, timeoutMs)', '    }, 0)']],
    },
    {
      name: 'abort: the caller signal no longer settles the request',
      check: 'transport: aborting the turn is null at once',
      edits: [[detector, "    deps.signal.addEventListener('abort', () => {\n      controller.abort()\n      resolve(null)\n    }, { once: true })", "    deps.signal.addEventListener('abort', () => {\n      controller.abort()\n      void 0\n    }, { once: true })"]],
    },
    {
      name: 'privacy: the player text is logged',
      check: 'privacy and usage: no log line carries the text; usage path is shared',
      edits: [[detector, "  const trimmed = String(text || '').trim()", "  console.log(text)\n  const trimmed = String(text || '').trim()"]],
    },
    {
      name: 'usage: the purpose is mislabeled',
      check: 'privacy and usage: no log line carries the text; usage path is shared',
      edits: [[detector, "purpose: 'reply_language_check',", "purpose: 'wrong_purpose',"]],
    },
    {
      name: 'gate: a player choice does not stop the check',
      check: 'gate at pickup: truth table',
      edits: [[detector, "  if (input.source === 'player') return false", '  if (false) return false']],
    },
    {
      name: 'chip: a different line matches the chip',
      check: 'chip test: a tapped chip is recognised from send or label',
      edits: [[detector, 'if (candidate && normalizeReplyText(candidate) === normalized) return true', 'if (candidate && normalizeReplyText(candidate) !== normalized) return true']],
    },
    {
      name: 'discard: the flag is forgotten',
      check: 'tapped chip: the answer and the count are discarded',
      edits: [[detector, '      discardedFlag = true\n      controller.abort()', '      controller.abort()']],
    },
    {
      name: 'wait: the ceiling is no longer 700 ms',
      check: 'wait: 700 ms ceiling on the first typed turn only, at most once',
      edits: [[detector, 'export const REPLY_LANGUAGE_WAIT_MS = 700', 'export const REPLY_LANGUAGE_WAIT_MS = 800']],
    },
    {
      name: 'wait: turn 2 waits again',
      check: 'wait: 700 ms ceiling on the first typed turn only, at most once',
      edits: [[detector, 'if (input.settled || input.discarded || (Number(input.checks) || 0) !== 0) return 0', 'if (input.settled || input.discarded) return 0']],
    },
    {
      name: 'off: the gate ignores disabled languages',
      check: 'off: no request is made and nothing waits',
      edits: [[detector, '  if (enabledCodes.length === 0) return false', '  if (false) return false']],
    },
    {
      name: 'processor: the same-turn apply is removed',
      check: 'processor: pickup start, packet chip test, prompt wait and same-turn apply',
      edits: [[processor, '  if (replyLanguageCheck.settled() && !replyLanguageCheck.discarded() && !replyLanguageApplied) {', '  if (false) {']],
    },
    {
      name: 'processor: the language check waits on the adult check',
      check: 'processor: the adult check is untouched and neither waits for the other',
      edits: [[processor, '  if (replyLanguageCheck.started) await replyLanguageCheck.waitAtPrompt(replyLanguagePrepEndedAt)', '  await intentRouter.wait(700)\n  if (replyLanguageCheck.started) await replyLanguageCheck.waitAtPrompt(replyLanguagePrepEndedAt)']],
    },
    {
      name: 'replay: the written memory stops being read',
      check: 'start of a save: setting, then writing memory, then English',
      edits: [[replyLanguage, '  if (written) return effectiveReplyLanguage(written, enabledCodes)?.code', '  if (written) return undefined']],
    },
  ]

  try {
    await cp(join(server, 'src'), join(root, 'src'), { recursive: true })
    await cp(join(server, 'worker'), join(root, 'worker'), { recursive: true })
    await mkdir(join(root, 'scripts'), { recursive: true })
    await cp(join(server, AUDIT), join(root, AUDIT))
    await symlink(join(server, 'node_modules'), join(root, 'node_modules'), 'dir')

    const runAudit = async () => {
      const child = Bun.spawn(['bun', '--no-env-file', 'run', AUDIT], {
        cwd: root,
        env: { ...process.env, NODE_ENV: 'test' },
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
      })
      const timer = setTimeout(() => child.kill(9), 120_000)
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      clearTimeout(timer)
      return { stdout, stderr, code }
    }

    const clean = await runAudit()
    assert.equal(clean.code, 0, `the unmutated copy must pass:\n${clean.stdout}\n${clean.stderr}`)
    console.log(`baseline: clean copy passes (${(clean.stdout.match(/^  ok /gm) ?? []).length} checks)`)

    let bitten = 0
    for (const mutation of mutations) {
      const originals = new Map<string, string>()
      try {
        for (const [file, from, to] of mutation.edits) {
          const path = join(root, file)
          const text = originals.get(path) ?? (await readFile(path, 'utf8'))
          originals.set(path, text)
          assert.ok(text.includes(from), `${mutation.name}: mutation anchor missing: ${from}`)
          await writeFile(path, text.replaceAll(from, to))
        }
        const result = await runAudit()
        assert.notEqual(result.code, 0, `${mutation.name}: the audit accepted the broken behaviour\n${result.stdout}`)
        assert.ok(
          `${result.stdout}${result.stderr}`.includes(`FAIL ${mutation.check}`),
          `${mutation.name}: failed outside the intended check\n${result.stdout}\n${result.stderr}`,
        )
        bitten++
        console.log(`BITE ${mutation.name}: exit ${result.code}; FAIL ${mutation.check}`)
      } finally {
        for (const [path, original] of originals) await writeFile(path, original)
      }
    }
    console.log(`reply-language detect bites: ${bitten}/${mutations.length} mutations rejected; scratch restored and removed`)
    if (bitten !== mutations.length) process.exit(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
