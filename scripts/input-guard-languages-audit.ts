/**
 * Audit for the Portuguese and Spanish input-guard packs
 * (src/utils/input-guard-languages.ts).
 *
 * Three questions, in order of importance:
 *   1. Innocent lines stay clear — adult drama, a partner's or friend's family,
 *      accusations, denials, confessions about someone else, parents with
 *      sleeping children, years together, age gaps between adults, expletives.
 *   2. The two narrow themes block, with the right category, in every listed
 *      form, including missing accents, asterisks and zero-width noise.
 *   3. The languages do not contaminate each other, and the English guard sees
 *      the same clear set when the save is English.
 *
 * Cases added for rl-s2's contract points are labelled `p2 ` … `p8 `, so the
 * count of what each point changed is checkable rather than asserted.
 *
 * Pure: no DB, no network.
 *
 *   bun --no-env-file run scripts/input-guard-languages-audit.ts
 *   bun --no-env-file run scripts/input-guard-languages-audit.ts --bites
 */
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { GUARD_MESSAGES, screenPlayerInput, type GuardCategory } from '../src/utils/input-guard'
import { screenPlayerInputIn } from '../src/utils/input-guard-languages'

type ClearCase = readonly [why: string, text: string]
type BlockCase = readonly [why: string, text: string, category: GuardCategory]

// ── Portuguese, must be clear ─────────────────────────────────────────────────

const PT_CLEAR: readonly ClearCase[] = [
  // ── family and children in another role (rl-s) ──
  ['children asleep and the act at the end', 'As crianças já estavam dormindo quando a gente transou.'],
  ['children asleep, act first', 'A gente transou bem devagar para não acordar as crianças.'],
  ['father saw us leaving', 'Meu pai nos viu saindo do quarto e não disse nada.'],
  ['at my sister’s house', 'Na casa da minha irmã a gente sempre dorme no sofá.'],
  ['transamos at my sister’s house', 'Transamos na casa da minha irmã no fim de semana.'],
  ['brother left before the act', 'Depois que meu irmão saiu, a gente transou no sofá.'],
  ['son sleeps at eight', 'Meu filho dorme às oito, então temos a noite toda.'],
  ['children at school, act after', 'Quando as crianças estão na escola, a gente transa sem pressa.'],
  ['baby woke and the mood ended', 'A bebê acordou no meio da noite e o clima acabou.'],
  ['brother looks after our children', 'Meu irmão mais novo cuida dos nossos filhos.'],
  ['daughter of my cousin', 'Ela é filha da minha prima e mora longe.'],
  ['uncle told a joke', 'Meu tio contou uma piada e todo mundo riu.'],
  ['father asleep while we had sex', 'A gente transou enquanto meu pai dormia no quarto ao lado.'],
  ['sister looked after the house', 'Minha irmã cuidou da casa enquanto viajamos.'],
  ['cousin lives with us', 'Meu primo mora com a gente desde o ano passado.'],
  ['wanted sex but the baby cried', 'A gente queria transar, mas o bebê chorou.'],
  ['father arrived during dinner', 'Meu pai chegou de surpresa no meio do jantar.'],
  ['sex after everyone left', 'A gente transou depois que todo mundo foi embora.'],
  ['aunt will stay with the children', 'Minha tia vai ficar com as crianças no sábado.'],
  ['brother’s room next to ours', 'O quarto do meu irmão é do lado do nosso.'],
  ['wife and the children at grandma’s', 'Minha esposa e as crianças foram dormir na casa da minha mãe.'],
  ['act while the children are at grandma’s', 'Aproveitamos que as crianças estavam na casa da avó e transamos.'],
  ['family lunch on Sunday', 'Todo domingo tem almoço na casa da minha mãe.'],
  ['conjunction before the family', 'A gente transou e meu pai chegou depois.'],
  ['children in the next room', 'As crianças dormiam no quarto ao lado e a gente transou baixinho.'],
  ['ellipsis before the children', 'A gente transou… com as crianças dormindo no quarto ao lado.'],
  ['vocative brother after the act', 'Transamos, meu irmão, depois falamos.'],
  ['act with the sisterhood', 'Ele transou com a irmandade.'],
  ['act with my sisterhood, own word', 'Eu transei com a minha irmandade.'],
  ['in-law at her house and the act', 'A gente transou na casa da minha sogra.'],
  ['in-law as the object', 'A gente transou com minha cunhada.'],
  ['religious title: brother João', 'Ele transou com o Irmão João.'],
  ['address: mamãe', 'Vou transar, mamãe, depois falamos.'],
  ['foder idiom: me fodi', 'Me fodi com minha irmã por causa da herança.'],
  ['foder idiom: vai se foder', 'Vai se foder, cara.'],
  ['foder idiom: se fodeu', 'Se fodeu, meu irmão vai rir.'],
  ['foder idiom: vai te foder', 'Vai te foder, meu irmão.'],
  ['foda-se is not a listed form', 'Foda-se, meu irmão.'],
  ['minor noun alone: garota', 'Ele transou com a garota.'],
  ['minor noun alone: novinha', 'Ele transou com a novinha.'],
  ['minor noun alone: bebê', 'Ele transou com a bebê.'],
  ['excluded body part: cu', 'Ela sentiu dor no cu e foi ao médico.'],

  // ── flirty address and slang ──
  ['flirty: you are a danger', 'Você é um perigo, sabia?'],
  ['flirty: if I catch you alone', 'Se eu te pegar sozinho, você vai ver.'],
  ['flirty: what a mouth', 'Que boca é essa, hein?'],
  ['flirty: come here', 'Vem cá que eu te conto um segredo.'],
  ['flirty: your smile undoes me', 'Você tem um sorriso que me desmonta.'],
  ['flirty: teasing me', 'Tá me provocando, é?'],
  ['flirty: that shirt', 'Essa camisa te cai muito bem.'],
  ['flirty: we will not leave the room', 'Se continuar assim, a gente não sai do quarto.'],
  ['flirty: beautiful today', 'Você está linda hoje, como sempre.'],
  ['flirty: I like your low voice', 'Gosto quando você fala baixo assim.'],
  ['slang: met at the party', 'A gente se conheceu na festa e ficou até de manhã.'],
  ['slang: attentive guy', 'Ele é um cara muito atencioso, todo mundo gosta dele.'],
  ['slang: going for a shower', 'Vou tomar um banho e já volto.'],
  ['slang: nervous in a good way', 'Você me deixa nervoso de um jeito bom.'],
  ['slang: talk tomorrow', 'Amanhã a gente conversa com calma.'],

  // ── expletives ──
  ['expletive: porra', 'Que porra de dia foi esse?'],
  ['expletive: caralho', 'Caralho, que susto!'],
  ['expletive: puta merda', 'Puta merda, esqueci a chave.'],
  ['expletive: merda', 'Que merda, o carro não liga.'],
  ['expletive: babaca', 'Ele é um babaca, mas é meu amigo.'],
  ['expletive: bosta', 'Não vou fazer essa bosta hoje.'],
  ['expletive: inferno', 'Que inferno de trânsito.'],
  ['expletive: vai à merda', 'Vai à merda, cara.'],
  ['expletive: saco', 'Que saco, de novo não.'],
  ['expletive: puto', 'Ele ficou puto com a notícia.'],
  ['expletive: porcaria', 'Que porcaria de internet.'],
  ['expletive: fudido with my brother', 'Tô fudido com essa conta, meu irmão vai me ajudar.'],
  ['fodido with my brother is not the act', 'Estou fodido com meu irmão por causa do carro.'],

  // ── medical talk ──
  ['medical: vaginal exam', 'O médico examinou a vagina e disse que estava tudo bem.'],
  ['medical: penile pain', 'Ela sentiu dor no pênis e foi ao urologista.'],
  ['medical: menopause', 'A vagina pode ficar sensível durante a menopausa.'],
  ['medical: prostate', 'O exame de próstata foi rápido e sem dor.'],
  ['medical: anus surgery', 'Ele fez cirurgia no ânus no ano passado.'],
  ['medical: orgasm is not required', 'O orgasmo não é obrigatório para ter prazer.'],
  ['medical: premature ejaculation', 'A ejaculação precoce tem tratamento.'],
  ['medical: breasts after nursing', 'Os seios ficaram doloridos depois da amamentação.'],
  ['medical: baby’s sex on the scan', 'O médico falou sobre o sexo do bebê na ultrassom.'],
  ['medical: appointment about sex and health', 'Ela marcou uma consulta para falar de sexo e saúde.'],
  ['medical: high blood pressure', 'A pressão está alta, preciso mudar a dieta.'],
  ['medical: blood test', 'O exame de sangue deu negativo.'],
  ['medical: physiotherapy', 'A fisioterapia ajudou muito na recuperação.'],
  ['medical: sexual history', 'O médico perguntou sobre a vida sexual dela.'],
  ['medical: anxiety medicine', 'Ele toma remédio para ansiedade desde março.'],

  // ── abuse backstory, no act window ──
  ['backstory: abuse as a child', 'Ele contou que sofreu abuso quando era criança, anos atrás.'],
  ['backstory: therapy helped her speak', 'A terapia ajudou ela a falar sobre o que aconteceu na infância.'],
  ['backstory: the uncle did bad things', 'Ela disse que o tio dela fez coisas ruins quando ela era pequena.'],
  ['backstory: the past is hard', 'O passado dela é difícil, mas ela está bem agora.'],
  ['backstory: never told the family', 'Ele nunca contou para a família o que o vizinho fez.'],
  ['backstory: her mother asked for help', 'A mãe dela percebeu e pediu ajuda.'],
  ['backstory: she can speak about it', 'Hoje ela consegue falar sobre aquilo sem chorar.'],
  ['backstory: the therapist on time', 'O terapeuta disse que levar tempo é normal.'],
  ['backstory: the letter never sent', 'Ela escreveu uma carta sobre o que sofreu e nunca enviou.'],
  ['backstory: the case years later', 'A justiça ouviu o caso anos depois.'],

  // ── ages and durations ──
  ['age: twenty-five', 'Tenho 25 anos e ainda moro com meus pais.'],
  ['age: faz cinco anos', 'Faz 5 anos que não vejo meu irmão.'],
  ['age: married ten years', 'Estamos casados há 10 anos.'],
  ['age: ten years married', 'Dez anos de casados e a gente ainda se gosta.'],
  ['age: she is thirty-two', 'Ela tem 32 anos e dois filhos.'],
  ['age: my son is eight', 'Meu filho tem 8 anos e adora dinossauros.'],
  ['age: since we were fifteen', 'A gente se conhece desde os 15 anos.'],
  ['age: started working at seventeen', 'Ele começou a trabalhar aos 17 anos.'],
  ['age: long time without sex', 'Faz muito tempo que não transo com ninguém.'],
  ['age: widowed at forty', 'Ela ficou viúva aos 40 e nunca mais casou.'],
  ['age: twenty years in the same house', 'Há 20 anos eles moram na mesma casa.'],
  ['age: grandfather is eighty', 'Meu avô tem 80 anos e joga futebol.'],
  ['age: married after eight years', 'A gente se casou depois de 8 anos de namoro.'],
  ['age: he is fourteen', 'Ele tem 14 anos e já sabe o que quer.'],
  ['age: working there since twenty-two', 'Ela trabalha lá desde os 22 anos.'],
  ['duration: ten years married and the act', 'Estamos casados há 10 anos e ainda transamos.'],
  ['duration: tem cinco anos que', 'Tem 5 anos que eu não transo.'],
  ['duration: faz cinco anos and the act', 'Faz 5 anos que eu transo com meu marido.'],
  ['a minor noun alone never counts', 'Ele transou com a menina.'],
  ['an adult age is not a minor age', 'Tenho 25 anos e transo com ele.'],
  ['an assurance of majority stays clear', 'Não é menor de idade, pode transar comigo.'],

  // ── sexo as gender, baby’s sex ──
  ['gender: the baby’s sex at the party', 'O sexo do bebê vai ser revelado na festa.'],
  ['gender: we do not know the child’s sex', 'Ainda não sabemos o sexo da criança.'],
  ['gender: sex does not define a person', 'O sexo não define o que a pessoa pode fazer.'],
  ['gender: sex education at home', 'Eles discutiram sobre sexo e educação em casa.'],
  ['gender: the sexologist’s talk', 'A sexóloga falou sobre sexualidade na palestra.'],
  ['gender: sex of plants', 'A aula de biologia explicou o sexo das plantas.'],
  ['gender: the puppy’s sex', 'O sexo do filhote ainda é desconhecido.'],
  ['gender: she did not want to know', 'Ela preferiu não saber o sexo antes do parto.'],

  // ── English inside Portuguese ──
  ['english inside pt: date', 'A gente fez um date rápido e voltou para casa.'],
  ['english inside pt: text', 'Ele mandou um text dizendo que estava chegando.'],
  ['english inside pt: amazing', 'O show foi amazing, todo mundo cantou junto.'],
  ['english inside pt: design', 'Ela trabalha com design e ama o que faz.'],
  ['english inside pt: upgrade', 'A gente deu um upgrade na casa ano passado.'],
  ['english inside pt: nice', 'Ele é muito nice com todo mundo.'],
  ['english inside pt: feedback', 'O feedback do chefe foi justo.'],
  ['english inside pt: like', 'Vou dar um like na sua foto.'],
  ['english inside pt: brainstorm', 'A gente fez um brainstorm para o projeto.'],
  ['english inside pt: sorry', 'Ela disse sorry quando chegou atrasada.'],
  ['english inside pt: meeting', 'O meeting foi cancelado de última hora.'],
  ['english inside pt: random', 'Ele é um cara muito random, mas divertido.'],
  ['english inside pt: coffee break', 'A gente deu uma pausa para o coffee break.'],
  ['english inside pt: best day ever', 'Ela postou uma foto com a legenda best day ever.'],
  ['english inside pt: app', 'O app travou de novo, que raiva.'],

  // ── names, case, punctuation, silence ──
  ['name: Filho in caps', 'FILHO, vem jantar!'],
  ['name: my brother, Filho', 'Meu irmão, o Filho, chegou tarde.'],
  ['name: Niña at the bakery', 'A Niña da padaria é muito simpática.'],
  ['name: Niño as a nickname', 'O pessoal chamava ele de Niño por causa do apelido.'],
  ['quotes: love note on the mirror', 'Ela escreveu "te amo" no espelho.'],
  ['quotes: a heart with her name', 'Ele desenhou um coração com o nome dela.'],
  ['asterisks: he smiled', '*Ele sorriu* e ela corou.'],
  ['quotes: come here, quietly', 'Ela disse baixinho: "vem".'],
  ['name: Criança as a nickname', 'O apelido dele é Criança porque ele é o mais novo da turma.'],
  ['name: Maria my neighbour', 'A Maria, minha vizinha, tem um gato chamado Bichano.'],
  ['accents missing: irmao', 'A gente transou e depois o meu irmao chegou.'],
  ['all caps: act and family at home', 'A GENTE TRANSOU NA CASA DA MINHA IRMÃ.'],
  ['zero width inside a family word', 'Meu ir\u200bmão chegou cedo.'],

  // ── adult scenes, none of the guarded words ──
  ['adult scene: neck kiss', 'Ele beijou o pescoço dela e ela suspirou.'],
  ['adult scene: undressed and held', 'A gente tirou a roupa e ficou abraçado na cama.'],
  ['adult scene: hand on her back', 'Ele passou a mão pelas costas dela devagar.'],
  ['adult scene: she bit her lip', 'Ela mordeu o lábio e olhou para ele.'],
  ['adult scene: kissing on the sofa', 'Os dois se beijaram no sofá até tarde.'],
  ['adult scene: whispered and laughed', 'Ele sussurrou no ouvido dela e ela riu.'],
  ['adult scene: slept in each other’s arms', 'A gente dormiu abraçado a noite inteira.'],
  ['adult scene: caressed her face', 'Ele acariciou o rosto dela com carinho.'],
  ['adult scene: on his lap', 'Ela sentou no colo dele e o beijo durou.'],
  ['adult scene: bodies close', 'Os corpos ficaram colados no calor da noite.'],
  ['adult scene: pulled by the waist', 'Ele a puxou pela cintura e ela se entregou ao beijo.'],
  ['adult scene: heavy breathing', 'A respiração dos dois ficou pesada.'],
  ['adult scene: shirt off', 'Ele tirou a camisa devagar e ela sorriu.'],
  ['adult scene: until sunrise', 'A gente ficou na cama até o sol nascer.'],
  ['adult scene: hand on his chest', 'Ela colocou a mão no peito dele e sentiu o coração.'],
  ['adult scene: the long kiss', 'O beijo foi longo e ninguém queria parar.'],

  // ── words excluded on purpose ──
  ['excluded: pica of the pliers', 'A pica do alicate quebrou na obra.'],
  ['excluded: pau de selfie', 'Ele comprou um pau de selfie na loja.'],
  ['excluded: rola of the boat', 'A rola do barco ficou presa na pedra.'],
  ['excluded: pene of the doll', 'O pene do boneco é de plástico.'],
  ['excluded: pênis of the baby', 'Ela falou sobre o pênis do bebê na consulta.'],
  ['excluded: coño as a Spanish expletive', 'Ele disse coño quando bateu o dedo.'],
  ['excluded: joder with my brother', 'Não joder com o meu irmão, ele está cansado.'],
  ['excluded: chingar as a joke', 'No México, chingar pode ser brincadeira entre amigos.'],
  ['excluded: coger the wrong bus', 'Ela não quis coger o ônibus errado.'],
  ['excluded: gozar on holiday', 'Gozar de férias é bom demais.'],
  ['excluded: chupar an ice cream', 'A gente vai chupar um sorvete na praia.'],
  ['excluded: trepar a tree', 'Ele trepava na árvore quando era moleque.'],
  ['excluded: penetrar with care', 'O médico vai penetrar com cuidado na região.'],
  ['excluded: correrse before the meeting', 'Não precisa correrse para a reunião.'],
  ['excluded: comer a pizza', 'A gente vai comer uma pizza hoje.'],
  ['excluded: pegar the bus', 'Ele tentou pegar o ônibus correndo.'],
  ['excluded: nua in the changing room', 'Ela ficou nua no vestiário e ninguém viu.'],
  ['excluded: pelada at carnival', 'A praia estava cheia de gente pelada no carnaval.'],
  ['excluded: desnuda in a painting', 'Ele contou que viu uma mulher desnuda na pintura.'],
  ['excluded: estuprar in the news', 'A polícia prendeu o homem que tentou estuprar a vizinha.'],
  ['excluded: violar the law', 'Violar a lei tem consequências.'],
  ['excluded: violence against women', 'A violência contra a mulher precisa ser denunciada.'],
  ['excluded: pais is a country here', 'Ele viajou para outro pais no ano passado.'],
  ['excluded: dois avos of the estate', 'Ele ficou com dois avos da herança.'],

  // ── Spanish inside a Portuguese save ──
  ['spanish inside pt: my mother’s house', 'La casa de mi madre siempre está llena.'],
  ['spanish inside pt: my sister called', 'Mi hermana me llamó ayer y hablamos un rato.'],
  ['spanish inside pt: her father', 'Ella dijo que su padre estaba bien.'],
  ['spanish inside pt: the boy and his cousin', 'El niño juega en el parque con su primo.'],
  ['spanish inside pt: see you tomorrow', 'Nos vemos mañana, tengo que trabajar.'],
  ['spanish inside pt: my aunt cooks', 'Mi tía cocina mejor que mi madre.'],
  ['spanish inside pt: her brother in Madrid', 'Su hermano vive en Madrid.'],
  ['spanish inside pt: grandma’s stories', 'La abuela cuenta historias de cuando era joven.'],
  ['spanish inside pt: my cousin visits', 'Mi prima va a visitarnos el próximo mes.'],
  ['spanish inside pt: the priest', 'El padre de la iglesia habló con los jóvenes.'],
  ['spanish inside pt: I like your Spanish', 'Me gusta cuando me hablas así, en español.'],
  ['shared words: my cousin and my uncle', 'Minha prima e meu tio vieram jantar.'],
  ['shared words: the orgasm is not the goal', 'O orgasmo não é a única coisa que importa.'],
  ['spanish inside pt: his wife and my brother', 'Mi esposa folló con mi hermano, pero ya lo hablamos.'],

  // ── p2: the owner of the relative must be the one acting ──
  ['p2 my wife slept with my brother', 'Minha esposa transou com meu irmão.'],
  ['p2 my girlfriend with my cousin', 'Minha namorada transou com meu primo na festa.'],
  ['p2 my husband with my sister', 'Descobri que meu marido transou com minha irmã.'],
  ['p2 my best friend with my cousin', 'Meu melhor amigo transou com a minha prima e eu não sabia.'],
  ['p2 she slept with my brother', 'Ela transou com o meu irmão depois da festa.'],
  ['p2 you slept with my brother (accusation)', 'Você transou com meu irmão?'],
  ['p2 you slept with my sister (accusation)', 'Você transou com a minha irmã?'],
  ['p2 tu form, my sister', 'Tu transaste com minha irmã?'],
  ['p2 third person plural, my sister', 'Vocês transaram com minha irmã?'],
  ['p2 my neighbour with my uncle', 'A minha vizinha transou com o meu tio.'],
  ['p2 I saw him with my sister', 'Eu vi quando ele transou com minha irmã.'],
  ['p2 the sister of my friend', 'Ele transou com a irmã do meu amigo.'],
  ['p2 the father of my friend', 'Ela transou com o pai do meu amigo.'],
  ['p2 his own sister', 'Ele transou com a irmã dele e a mãe descobriu.'],
  ['p2 his own sister, reported', 'Ela contou que transou com o irmão dele.'],
  ['p2 the neighbour and his sister', 'Meu vizinho fodeu com a irmã dele, todo mundo comenta.'],
  ['p2 the neighbour’s daughter', 'Ele transou com a filha do vizinho.'],
  ['p2 his sister, not mine', 'Ele transou com a sua irmã, não com a minha.'],
  ['p2 your sister, he slept with her', 'Ele transou com tua irmã, e eu não sabia.'],
  ['p2 my friend’s cousin', 'A gente transou com o primo da minha amiga.'],
  ['p2 my sister with her boyfriend', 'Minha irmã transou com o namorado dela.'],
  ['p2 my brother with his girlfriend', 'Meu irmão transou com a namorada dele.'],
  ['p2 the sister of my neighbour', 'Eu transei com a irmã da minha vizinha.'],
  ['p2 he watched my brother', 'Eu vi meu irmão transar com a vizinha.'],
  ['p2 no possesssive before the noun', 'Ele transou com a irmã sem dizer nada.'],
  ['p2 a guy, not an uncle', 'Follé con un tío'], // Spanish inside a Portuguese save
  ['p2 nobody with my sister', 'Ninguém transou com minha irmã, ela é séria.'],
  ['p2 you with your own sister (no você)', 'Tu transaste com sua irmã?'],

  // ── p3: denial is clear ──
  ['p3 never with my sister', 'Nunca transei com minha irmã, juro.'],
  ['p3 never with your sister', 'Nunca transei com sua irmã, juro.'],
  ['p3 I did not sleep with your sister', 'Eu não transei com a sua irmã.'],
  ['p3 jamais with my cousin', 'Jamais fodi com minha prima.'],
  ['p3 I do not sleep with my cousins', 'Eu não transo com minhas primas.'],
  ['p3 she never slept with my brother', 'Ela nunca transou com meu irmão.'],
  ['p3 we never slept with our cousins', 'A gente nunca transou com os nossos primos.'],
  ['p3 I do not want to hear about it', 'Não quero saber de transar com meu irmão.'],
  ['p3 never, long form', 'Eu nunca vou transar com minha irmã.'],

  // ── p4: someone else nearby is clear ──
  ['p4 parents with the children asleep', 'Transamos com as crianças dormindo no sofá.'],
  ['p4 children asleep, act first', 'Fizemos amor com as crianças dormindo no quarto.'],
  ['p4 children asleep at home', 'Fizemos sexo com as crianças em casa.'],
  ['p4 while the children slept', 'A gente transou enquanto as crianças dormiam.'],
  ['p4 when the boys sleep', 'A gente transa quando os meninos dormem.'],
  ['p4 door open and the children asleep', 'Eu transei com a porta aberta e as crianças dormindo.'],
  ['p4 children at home', 'A gente transou com as crianças em casa, mas baixinho.'],
  ['p4 sister asleep beside us', 'Eu transei com minha irmã dormindo na cama ao lado.'],

  // ── p5: talking about it is clear ──
  ['p5 about sex with his own sister', 'Conversamos sobre sexo com a própria irmã dele e ficou estranho.'],
  ['p5 talked about oral sex with his own sister', 'Falamos de sexo oral com a própria irmã dele.'],
  ['p5 about sex and the children', 'Falamos sobre sexo com as crianças na escola.'],

  // ── p6: words removed or narrowed ──
  ['p6 fodeu is an exclamation', 'Fodeu, meu irmão chegou.'],
  ['p6 foderam is an exclamation', 'Foderam tudo e depois meu irmão apareceu.'],
  ['p6 fode is not an act', 'Ele fode com o trabalho, minha irmã reclama.'],
  ['p6 transe is a trance', 'Ele entrou em transe na cerimônia, minha irmã filmou.'],
  ['p6 transado needs ter', 'Ele é transado, minha irmã acha engraçado.'],
  ['p6 vai foder is an idiom', 'Vai foder, minha irmã vai rir.'],
  ['p6 vai vá foder is an idiom', 'Vá foder, meu irmão.'],
  ['p6 vão foder is an idiom', 'Vão foder, meus irmãos.'],
  ['p6 foder-se is an idiom', 'Foder-se, meu irmão já foi.'],
  ['p6 fodeu with a daughter is not the act', 'Fodeu tudo na festa, minha filha reclamou.'],
  ['p6 foderam is not the act', 'Foderam o carro, meu irmão ficou puto.'],
  ['p6 transado without ter', 'Ele é transado, minha irmã acha engraçado.'],
  ['p6 transe with an act-looking word', 'Ela entrou em transe, minha irmã chamou o médico.'],

  // ── p7: stated age, leniency ──
  ['p7 five years without sex', 'Estou há 5 anos sem transar.'],
  ['p7 ten years older', 'Ela tem 10 anos a mais que eu e a gente transa muito.'],
  ['p7 ten years older, no act verb', 'Ela tem 10 anos a mais que eu.'],
  ['p7 eight years of dating', 'Tem 8 anos que a gente namora e transa.'],
  ['p7 ages 22 and 45', 'Ele tem 22 anos e eu tenho 45, e transamos bem.'],
  ['p7 fifteen years older, plural', 'Somos 15 anos mais velhos que eles e transamos igual.'],
  ['p7 married twelve years', 'Faz 12 anos que a gente transa e continua bom.'],
  ['p7 married ten years and the act', 'Dez anos de casados e a gente transa todo dia.'],
  ['p7 relationship is the subject', 'Meu namoro tem 6 anos e a gente transa sempre.'],
  ['p7 house is the subject', 'Minha casa tem 6 anos e a gente transa aqui sempre.'],
  ['p7 with the children at home', 'Meu filho tem 5 anos e a gente transa quando ele dorme.'],

  // ── p8: coded terms, each occurrence alone ──
  ['p8 nobody is a minor here', 'Aqui ninguém é menor de idade, vamos transar.'],
  ['p8 not a minor, assurance', 'Não sou menor de idade, podemos transar.'],
  ['p8 nobody is a minor, long', 'Aqui não tem nenhum menor de idade, vamos transar.'],
  ['p8 we are all adults', 'Nós somos todos maior de idade e queremos transar.'],

  // ── moved from rl-s blocked: family with no possessive (point 1) ──
  ['moved rl-s: sister, no possessive', 'Ele transou com a irmã.'],
  ['moved rl-s: father, no possessive', 'Ela transou com o pai.'],
  ['moved rl-s: fodeu is not an act', 'Ele fodeu com a filha.'],
  ['moved rl-s: open act, no possessive', 'Ele está fodendo com a prima.'],
  ['moved rl-s: gerund, no possessive', 'Fazendo amor com a avó.'],
  ['moved rl-s: oral sex, no possessive', 'Sexo oral com a irmã.'],
  ['moved rl-s: anal sex, no possessive', 'Sexo anal com o irmão.'],
  ['moved rl-s: sex with, no possessive', 'Sexo com a mãe.'],
  ['moved rl-s: dele is not the window', 'Ele transou com a irmã dele.'],
  ['moved rl-s: cousin plural, no possessive', 'Fizemos amor com as primas.'],
  ['moved rl-s: nephews plural', 'Ele transou com os sobrinhos.'],
  ['moved rl-s: stepmother', 'Ele transou com a madrasta.'],
  ['moved rl-s: stepfather', 'Ela transou com o padrasto.'],
  ['moved rl-s: stepdaughter', 'Ele transou com a enteada.'],
  ['moved rl-s: masturbar, no possessive', 'Masturbar com a irmã.'],
  ['moved rl-s: ejaculou with mother', 'Ele ejaculou com a mãe.'],
  ['moved rl-s: orgy with the brothers', 'Orgia com os irmãos.'],
  ['moved rl-s: suruba with the sister', 'Suruba com a irmã.'],
  ['moved rl-s: boquete with the brother', 'Boquete com o irmão.'],
  ['moved rl-s: fodeu no possessive', 'Ele fodeu minha irmã.'],
  ['moved rl-s: open act, possessive, no marker', 'Ele transou minha prima.'],
  ['moved rl-s: gerund with article', 'Ele fodendo a filha.'],
  ['moved rl-s: masturbando, article', 'Masturbando a irmã.'],
  ['moved rl-s: masturba, present', 'Ela masturba o filho.'],
  ['moved rl-s: transando, gerund', 'Ele transando com a irmã.'],
  ['moved rl-s: fazer sexo, infinitive', 'Fazer sexo com a irmã.'],

  ['moved rl-s: bare family object', 'Ele transou irmã.'],
  ['moved rl-s: daughters plural', 'Ele transou com as filhas.'],
  ['moved rl-s: sons plural', 'Ele transou com os filhos.'],
  ['moved rl-s: niece', 'Ele transou com a sobrinha.'],
  ['moved rl-s: nephew', 'Ele transou com o sobrinho.'],
  ['moved rl-s: female cousin', 'Ele transou com a prima.'],
  ['moved rl-s: female cousins, plural', 'Ele transou com as primas.'],
  ['moved rl-s: male cousin', 'Ele transou com o primo.'],
  ['moved rl-s: grandmother', 'Ele transou com a avó.'],
  ['moved rl-s: grandfather', 'Ele transou com o avô.'],
  ['moved rl-s: stepdaughters plural', 'Ele transou com as enteadas.'],
  ['moved rl-s: stepsons plural', 'Ele transou com os enteados.'],
  ['moved rl-s: aunt', 'Ele transou com a tia.'],
  ['moved rl-s: uncle', 'Ele transou com o tio.'],
  ['moved rl-s: grandparents plural', 'Ele transou com os avós.'],
  ['moved rl-s: sisters plural', 'Ele transou com as irmãs.'],
  ['moved rl-s: mothers plural', 'Ele transou com as mães.'],
  ['moved rl-s: stepmothers plural', 'Ele transou com as madrastas.'],
  ['moved rl-s: siririca with the sister', 'Ele falou de siririca com a irmã.'],
  ['moved rl-s: punheta with the brother', 'Ele falou de punheta com o irmão.'],
  ['moved rl-s: buceta with the sister', 'Ele falou de buceta com a irmã.'],
  ['moved rl-s: boceta with the sister', 'Ele falou de boceta com a irmã.'],
  ['moved rl-s: xoxota with the sister', 'Ele falou de xoxota com a irmã.'],
  ['moved rl-s: orgasmo with the sister', 'Ele falou de orgasmo com a irmã.'],
  ['moved rl-s: ejacular with the sister', 'Ele falou de ejacular com a irmã.'],
  ['moved rl-s: fode with the daughter', 'Ele fode com a filha.'],
  ['moved rl-s: asterisks, no possessive', '*Ele transou com a irmã*'],
  ['moved rl-s: quoted, no possessive', 'Ele transou com a "irmã".'],
  ['moved rl-s: zero width after the noun, no possessive', 'Ele transou com a irmã\u200d.'],
  ['moved rl-s: transava, imperfect', 'Ele transava com a irmã.'],
  ['moved rl-s: transaram, third plural', 'Eles transaram com a irmã.'],
  ['moved rl-s: open act, one token before com', 'Ele transou hoje com a irmã.'],
  ['moved rl-s: masturbando, no article', 'Ela masturbando o filho.'],
  ['moved rl-s: fazendo sexo', 'Fazendo sexo com a irmã.'],
  ['moved rl-s: fiz sexo', 'Fiz sexo com a irmã.'],
  ['moved rl-s: fizemos amor', 'Fizemos amor com a irmã.'],
  ['moved rl-s: fazer amor', 'Fazer amor com a irmã.'],
  ['moved rl-s: accent-less mother, bare', 'Ele transou com a mae.'],
  ['moved rl-s: accent-less sister, bare', 'Ele transou com a irma.'],
  ['moved rl-s: accent-less brother, bare', 'Ele transou com o irmao.'],
  ['moved rl-s: accent-less grandmother, bare', 'Ele transou com a avo.'],
  ['moved rl-s: Loli is a name', 'Loli, ele transou com ela.'],
  ['moved rl-s: fodemos, no possessive', 'Fodemos com a filha.'],
  ['moved rl-s: fodia, no possessive', 'Ele fodia com a filha.'],
  ['moved rl-s: faço sexo, no possessive', 'Faço sexo com a irmã.'],
]

// ── Portuguese, must block ────────────────────────────────────────────────────

const PT_BLOCKED: readonly BlockCase[] = [
  // ── p2: first-person forms with the first-person possessive ──
  ['p2 I slept with my sister', 'Eu transei com minha irmã.', 'incest'],
  ['p2 I slept with my mother', 'Transei com minha mãe.', 'incest'],
  ['p2 I sleep with my cousin', 'Eu transo com minha prima.', 'incest'],
  ['p2 I fuck with my cousin', 'Fodo com minha prima.', 'incest'],
  ['p2 we fucked with our niece', 'Fodemos com nossa sobrinha.', 'incest'],
  ['p2 I sleep with my brother', 'Eu transo com meu irmão quando ele vem.', 'incest'],
  ['p2 I had sex with my aunt', 'Fiz sexo com minha tia.', 'incest'],
  ['p2 we made love with our cousins', 'Fizemos amor com nossos primos.', 'incest'],
  ['p2 I masturbated with my sister', 'Masturbei com minha irmã.', 'incest'],
  ['p2 we used to sleep with our children', 'Transávamos com nossos filhos.', 'incest'],
  ['p2 I make love with my sister', 'Faço sexo com minha irmã.', 'incest'],
  ['p2 we slept with our mother', 'Nós transamos com nossa mãe.', 'incest'],
  ['p2 I slept with my father', 'Transei com meu pai.', 'incest'],
  ['p2 I fucked with my brother', 'Fodi com meu irmão.', 'incest'],
  ['p2 my sister, first person plural', 'A gente transou com nossa irmã.', 'incest'],

  // ── p2: infinitive with a first-person marker ──
  ['p2 I want to sleep with my sister', 'Eu quero transar com minha irmã.', 'incest'],
  ['p2 I am going to fuck with my sister', 'Eu vou foder com minha irmã.', 'incest'],
  ['p2 I need to have sex with my daughter', 'Eu preciso fazer sexo com minha filha.', 'incest'],
  ['p2 let us sleep with my sister', 'Vamos transar com minha irmã.', 'incest'],
  ['p2 I think about sleeping with my sister', 'Eu penso em transar com minha irmã.', 'incest'],
  ['p2 I started sleeping with my sister', 'Eu comecei a transar com minha irmã.', 'incest'],
  ['p2 I like sleeping with my brother', 'Eu gosto de transar com meu irmão.', 'incest'],
  ['p2 I had been sleeping with my sister', 'Eu tinha transado com minha irmã.', 'incest'],
  ['p2 we had been sleeping with our cousin', 'Nós tínhamos transado com nossa prima.', 'incest'],

  // ── p2: own-relative with própria ──
  ['p2 his own sister', 'Ele transou com a própria irmã.', 'incest'],
  ['p2 her own son', 'Ela transa com o próprio filho.', 'incest'],
  ['p2 his own mother', 'Ele transou com a própria mãe.', 'incest'],
  ['p2 our own cousin', 'Fizemos amor com a própria prima.', 'incest'],
  ['p2 oral sex, own sister', 'Sexo oral com a própria irmã.', 'incest'],
  ['p2 talking with his own sister', 'Ele falou de siririca com a própria irmã.', 'incest'],

  // ── p2: second person ──
  ['p2 tu with your sister', 'Tu transaste com tua irmã.', 'incest'],
  ['p2 voce with your sister', 'Você transou com sua irmã.', 'incest'],
  ['p2 voce with your daughter', 'Você transa com sua filha.', 'incest'],
  ['p2 tu with your brother', 'Tu transas com teu irmão.', 'incest'],

  // ── p7: stated age with de idade, and minors ──
  ['p7 fifteen with de idade', 'Tenho 15 anos de idade e transo com ele.', 'minor_sexual'],
  ['p7 fifteen, plain', 'Tenho 15 anos e transo com ele.', 'minor_sexual'],
  ['p7 she is fourteen', 'Ela tem 14 anos e transou com ele.', 'minor_sexual'],
  ['p7 sixteen, comma', 'Tenho 16 anos, quero transar.', 'minor_sexual'],
  ['p7 thirteen, first person', 'Eu tenho 13 anos e quero foder com ele.', 'minor_sexual'],
  ['p7 child, singular', 'Ele transou com a criança.', 'minor_sexual'],
  ['p7 girl with a digit age', 'Ele transou com a menina de 12 anos.', 'minor_sexual'],
  ['p7 girls with a digit age', 'Ele transou com meninas de 13 anos.', 'minor_sexual'],
  ['p7 menor de idade', 'Ele transou com a menor de idade.', 'minor_sexual'],
  ['p7 adolescents', 'Ele transou com os adolescentes.', 'minor_sexual'],
  ['p7 adolescent', 'Ele transou com a adolescente.', 'minor_sexual'],
  ['p7 loli lowercase', 'loli, ele transou com ela.', 'minor_sexual'],
  ['p7 lolicon', 'Lolicon, transar.', 'minor_sexual'],
  ['p7 shotacon', 'Shotacon, sexo oral.', 'minor_sexual'],

  // ── p8: a negator that the clause turns around does not clear ──
  ['p8 without her being a minor', 'Sem que seja menor de idade, quero transar.', 'minor_sexual'],

  // ── review: the minor acts, and a desire that won't stop ──
  ['review minors acting', 'Quero ver duas crianças transando.', 'minor_sexual'],
  ['review cannot stop', 'Eu não consigo parar de transar com minha irmã.', 'incest'],

  // ── missing accents ──
  ['accent-less mother', 'Transei com a minha mae.', 'incest'],
  ['accent-less sister', 'Transei com a minha irma.', 'incest'],
  ['accent-less brother', 'Transei com o meu irmao.', 'incest'],
  ['accent-less child', 'Ele transou com a crianca.', 'minor_sexual'],
  ['accent-less grandmother', 'Transei com a minha avo.', 'incest'],

  // ── obfuscation ──
  ['all caps', 'SEXO COM MINHA IRMÃ.', 'incest'],
  ['asterisks around the line', '*Eu transei com minha irmã*', 'incest'],
  ['zero width inside the family word', 'Eu transei com minha ir\u200bmã.', 'incest'],
  ['quoted family word', 'Eu transei com minha "irmã".', 'incest'],
  ['zero width after the family word', 'Eu transei com minha irmã\u200d.', 'incest'],

  // ── more act forms, first person ──
  ['transava with eu', 'Eu transava com minha irmã.', 'incest'],
  ['transando with estou', 'Estou transando com minha irmã.', 'incest'],
  ['fodia with eu', 'Eu fodia com minha filha.', 'incest'],
  ['ejaculei with minha', 'Eu ejaculei com minha irmã.', 'incest'],
  ['fodendo at the clause start', 'Fodendo com a minha irmã.', 'incest'],
  ['fazendo sexo at the clause start', 'Fazendo sexo com a minha irmã.', 'incest'],
  ['masturbo at the clause start', 'Masturbo o meu filho.', 'incest'],
  ['siririca with minha irmã', 'Siririca com minha irmã.', 'incest'],
  ['orgasmo with minha prima', 'Orgasmo com minha prima.', 'incest'],
  ['own stepdaughter', 'Ele transou com a própria enteada.', 'incest'],
  ['one token then com, first person', 'Eu transei hoje com minha irmã.', 'incest'],
  ['faço sexo, first person possessive', 'Faço sexo com minha irmã.', 'incest'],
  ['fazendo amor, first person possessive', 'Fizemos amor com a nossa irmã.', 'incest'],
  ['plural primas, first person', 'Nós transamos com nossas primas.', 'incest'],

  // ── every remaining rl-s blocked line, kept where it was (point 10) ──
  ['rl-s: mother, present', 'Eu transo com minha mãe.', 'incest'],
  ['rl-s: brother, article and possessive', 'Transamos com o meu irmão.', 'incest'],
  ['rl-s: nephew, first person', 'Eu fodo com meu sobrinho.', 'incest'],
  ['rl-s: aunt, fiz sexo', 'Fiz sexo com a minha tia.', 'incest'],
  ['rl-s: cousin, fizemos sexo', 'Fizemos sexo com o nosso primo.', 'incest'],
  ['rl-s: children, plural', 'Ele transou com as crianças.', 'minor_sexual'],
  ['rl-s: menores de idade', 'Ele transou com menores de idade.', 'minor_sexual'],
  ['rl-s: boy with ten', 'Ele transou com o menino de 10 anos.', 'minor_sexual'],
  ['rl-s: garota with fifteen', 'Ele transou com a garota de 15 anos.', 'minor_sexual'],
  ['rl-s: garoto with sixteen', 'Ele transou com o garoto de 16 anos.', 'minor_sexual'],
  ['rl-s: girl with a word age', 'Ele transou com a menina de doze anos.', 'minor_sexual'],
  ['rl-s: girl with an age after a comma', 'Ele transou com a menina, 11 anos.', 'minor_sexual'],
  ['rl-s: teen with a stated age', 'Ele transou com uma adolescente de 13 anos.', 'minor_sexual'],
  ['rl-s: first person stated age', 'Tenho 14 anos e transo com ele.', 'minor_sexual'],
  ['rl-s: third person stated age', 'Ela tem 15 anos e transou com ele.', 'minor_sexual'],
  ['rl-s: word age, first person', 'Eu tenho dezesseis anos e fodo com ele.', 'minor_sexual'],
  ['rl-s: word age, third person', 'Ele tem 12 anos e fizemos sexo.', 'minor_sexual'],
  ['rl-s: reported age', 'Ele disse que tem 13 anos e transou.', 'minor_sexual'],
  ['rl-s: shota with an act', 'Shota, ele transou.', 'minor_sexual'],
  ['rl-s: child and menor de idade', 'Ele transou com a criança, menor de idade.', 'minor_sexual'],
  ['rl-s: girl with seventeen', 'Ele transou com a garota de 17 anos.', 'minor_sexual'],
  ['rl-s: boy with nine', 'Ela transou com o menino de 9 anos.', 'minor_sexual'],
]

// ── Spanish, must be clear ────────────────────────────────────────────────────

const ES_CLEAR: readonly ClearCase[] = [
  // ── family and children in another role (rl-s) ──
  ['children asleep and the act at the end', 'Los niños ya estaban dormidos cuando hicimos el amor.'],
  ['children asleep, act first', 'Hicimos el amor despacio para no despertar a los niños.'],
  ['father saw us leaving', 'Mi padre nos vio salir del cuarto y no dijo nada.'],
  ['at my mother’s house', 'En casa de mi madre siempre dormimos en el sofá.'],
  ['sex at my mother’s house', 'Tuvimos sexo en casa de mi madre el fin de semana.'],
  ['brother left before the act', 'Después de que mi hermano se fue, tuvimos sexo en el sofá.'],
  ['son sleeps at eight', 'Mi hijo duerme a las ocho, así que tenemos la noche libre.'],
  ['children at school', 'Cuando los niños están en la escuela, tenemos tiempo para nosotros.'],
  ['baby woke and the mood ended', 'La bebé se despertó a media noche y se acabó el momento.'],
  ['brother looks after our children', 'Mi hermano menor cuida de nuestros hijos.'],
  ['daughter of my cousin', 'Ella es hija de mi prima y vive lejos.'],
  ['uncle told a joke', 'Mi tío contó un chiste y todos se rieron.'],
  ['father asleep while we had sex', 'Tuvimos sexo mientras mi padre dormía en el cuarto de al lado.'],
  ['sister looked after the house', 'Mi hermana cuidó la casa mientras viajábamos.'],
  ['cousin lives with us', 'Mi primo vive con nosotros desde el año pasado.'],
  ['wanted sex but the baby cried', 'Queríamos tener sexo, pero el bebé se puso a llorar.'],
  ['father arrived during dinner', 'Mi padre llegó de sorpresa en medio de la cena.'],
  ['sex after everyone left', 'Tuvimos sexo después de que todos se fueron.'],
  ['aunt will stay with the children', 'Mi tía va a quedarse con los niños el sábado.'],
  ['brother’s room next to ours', 'El cuarto de mi hermano está al lado del nuestro.'],
  ['wife and children at grandma’s', 'Mi esposa y los niños fueron a dormir a casa de mi madre.'],
  ['act while the children were at grandma’s', 'Aprovechamos que los niños estaban en casa de la abuela y tuvimos sexo.'],
  ['family lunch on Sunday', 'Todos los domingos hay comida en casa de mi madre.'],
  ['act and the father arrived after', 'Tuvimos sexo y mi padre llegó después.'],
  ['children in the next room', 'Los niños dormían en el cuarto de al lado e hicimos el amor bajito.'],

  // ── flirty address and slang ──
  ['flirty: you are a danger', 'Eres un peligro, ¿lo sabes?'],
  ['flirty: if I catch you alone', 'Si te agarro a solas, vas a ver.'],
  ['flirty: what a mouth', 'Qué boca tienes, ¿eh?'],
  ['flirty: come here', 'Ven acá que te cuento un secreto.'],
  ['flirty: your smile disarms me', 'Tienes una sonrisa que me desarma.'],
  ['flirty: teasing me', 'Me estás provocando, ¿verdad?'],
  ['flirty: that shirt', 'Esa camisa te queda muy bien.'],
  ['flirty: we will not leave the room', 'Si sigues así, no salimos del cuarto.'],
  ['flirty: beautiful today', 'Estás preciosa hoy, como siempre.'],
  ['flirty: low voice', 'Me gusta cuando hablas bajito así.'],
  ['slang: met at the party', 'Nos conocimos en la fiesta y nos quedamos hasta la mañana.'],
  ['slang: attentive guy', 'Él es un tipo muy atento, a todos les cae bien.'],
  ['slang: going for a shower', 'Voy a darme una ducha y vuelvo.'],
  ['slang: nervous in a good way', 'Me pones nervioso de una forma buena.'],
  ['slang: talk tomorrow', 'Mañana hablamos con calma.'],

  // ── expletives ──
  ['expletive: coño', '¡Qué coño de día fue este!'],
  ['expletive: joder', '¡Joder, qué susto!'],
  ['expletive: mierda', 'Qué mierda, olvidé la llave.'],
  ['expletive: cabrón', 'Qué cabrón, me quitó el sitio.'],
  ['expletive: no voy a hacer esta mierda', 'No voy a hacer esta mierda hoy.'],
  ['expletive: infierno', 'Qué infierno de tráfico.'],
  ['expletive: vete a la mierda tío', 'Vete a la mierda, tío.'],
  ['expletive: cojones', 'Qué cojones, otra vez no.'],
  ['expletive: cabreado', 'Está cabreado con la noticia.'],
  ['expletive: porquería', 'Qué porquería de internet.'],
  ['expletive: jodido with my brother', 'Estoy jodido con esta cuenta, mi hermano me va a ayudar.'],
  ['expletive: me cago en la leche', 'Me cago en la leche, se me rompió el móvil.'],

  // ── medical talk ──
  ['medical: vaginal exam', 'El médico examinó la vagina y dijo que todo estaba bien.'],
  ['medical: penile pain', 'Le dolía el pene y fue al urólogo.'],
  ['medical: menopause', 'La vagina puede estar sensible durante la menopausia.'],
  ['medical: prostate', 'El examen de próstata fue rápido y sin dolor.'],
  ['medical: anus surgery', 'Le operaron el ano el año pasado.'],
  ['medical: orgasm is not required', 'El orgasmo no es obligatorio para sentir placer.'],
  ['medical: premature ejaculation', 'La eyaculación precoz tiene tratamiento.'],
  ['medical: breasts after nursing', 'Los pechos le dolían después de la lactancia.'],
  ['medical: baby’s sex on the scan', 'El médico habló del sexo del bebé en la ecografía.'],
  ['medical: appointment about sex and health', 'Ella pidió una cita para hablar de sexo y salud.'],
  ['medical: high blood pressure', 'La presión está alta, tengo que cambiar la dieta.'],
  ['medical: blood test', 'El análisis de sangre salió negativo.'],
  ['medical: physiotherapy', 'La fisioterapia ayudó mucho en la recuperación.'],
  ['medical: sexual history', 'El médico preguntó por su vida sexual.'],
  ['medical: anxiety medicine', 'Toma medicina para la ansiedad desde marzo.'],

  // ── abuse backstory, no act window ──
  ['backstory: abuse as a child', 'Él contó que sufrió abuso cuando era niño, hace años.'],
  ['backstory: therapy helped her speak', 'La terapia la ayudó a hablar de lo que pasó en la infancia.'],
  ['backstory: the uncle did bad things', 'Ella dijo que su tío le hizo cosas malas cuando era pequeña.'],
  ['backstory: the past is hard', 'Su pasado es difícil, pero ahora está bien.'],
  ['backstory: never told the family', 'Nunca le contó a la familia lo que hizo el vecino.'],
  ['backstory: her mother asked for help', 'Su madre se dio cuenta y pidió ayuda.'],
  ['backstory: she can speak about it', 'Hoy puede hablar de aquello sin llorar.'],
  ['backstory: the therapist on time', 'El terapeuta dijo que tomarse tiempo es normal.'],
  ['backstory: the letter never sent', 'Escribió una carta sobre lo que sufrió y nunca la envió.'],
  ['backstory: the case years later', 'La justicia escuchó el caso años después.'],

  // ── ages and durations ──
  ['age: twenty-five', 'Tengo 25 años y todavía vivo con mis padres.'],
  ['age: hace cinco años', 'Hace 5 años que no veo a mi hermano.'],
  ['age: married ten years', 'Llevamos 10 años casados.'],
  ['age: ten years married', 'Diez años de casados y todavía nos queremos.'],
  ['age: she is thirty-two', 'Ella tiene 32 años y dos hijos.'],
  ['age: my son is eight', 'Mi hijo tiene 8 años y le encantan los dinosaurios.'],
  ['age: since we were fifteen', 'Nos conocemos desde los 15 años.'],
  ['age: started working at seventeen', 'Empezó a trabajar a los 17 años.'],
  ['age: long time without sex', 'Hace mucho que no tengo sexo con nadie.'],
  ['age: widowed at forty', 'Ella enviudó a los 40 y nunca volvió a casarse.'],
  ['age: twenty years in the same house', 'Hace 20 años que viven en la misma casa.'],
  ['age: grandfather is eighty', 'Mi abuelo tiene 80 años y juega al fútbol.'],
  ['age: married after eight years', 'Nos casamos después de 8 años de novios.'],
  ['age: he is fourteen', 'Él tiene 14 años y ya sabe lo que quiere.'],
  ['age: working there since twenty-two', 'Ella trabaja allí desde los 22 años.'],
  ['duration: ten years married and the act', 'Llevamos 10 años casados y todavía follamos.'],
  ['duration: tiene cinco años que', 'Tiene 5 años que no follamos.'],
  ['duration: hace cinco años and the act', 'Hace 5 años que follo con mi marido.'],

  // ── sexo as gender, baby’s sex ──
  ['gender: the baby’s sex at the party', 'El sexo del bebé se revela en la fiesta.'],
  ['gender: we do not know the creature’s sex', 'Todavía no sabemos el sexo de la criatura.'],
  ['gender: sex does not define a person', 'El sexo no define lo que una persona puede hacer.'],
  ['gender: sex education at home', 'Hablaron del sexo y la educación en casa.'],
  ['gender: the sexologist’s talk', 'La sexóloga habló de sexualidad en la charla.'],
  ['gender: sex of plants', 'La clase de biología explicó el sexo de las plantas.'],
  ['gender: the puppy’s sex', 'El sexo del cachorro todavía es desconocido.'],
  ['gender: she did not want to know', 'Ella prefirió no saber el sexo antes del parto.'],
  ['shared words: the Spanish “are”', 'Los dos son adultos y su deseo sexual es evidente.'],

  // ── English inside Spanish ──
  ['english inside es: date', 'Hicimos un date rápido y volvimos a casa.'],
  ['english inside es: text', 'Me mandó un text diciendo que llegaba.'],
  ['english inside es: amazing', 'El show fue amazing, todos cantaron.'],
  ['english inside es: design', 'Ella trabaja en design y ama lo que hace.'],
  ['english inside es: upgrade', 'El año pasado dimos un upgrade a la casa.'],
  ['english inside es: nice', 'Es muy nice con todo el mundo.'],
  ['english inside es: feedback', 'El feedback del jefe fue justo.'],
  ['english inside es: like', 'Voy a dar un like a tu foto.'],
  ['english inside es: brainstorm', 'Hicimos un brainstorm para el proyecto.'],
  ['english inside es: sorry', 'Ella dijo sorry cuando llegó tarde.'],
  ['english inside es: meeting', 'El meeting se canceló a última hora.'],
  ['english inside es: random', 'Es un tipo muy random, pero divertido.'],
  ['english inside es: coffee break', 'Hicimos una pausa para el coffee break.'],
  ['english inside es: best day ever', 'Ella publicó una foto con la frase best day ever.'],
  ['english inside es: app', 'La app se colgó otra vez, qué rabia.'],

  // ── names, case, punctuation, silence ──
  ['name: Niño in caps', 'NIÑO, ven a cenar.'],
  ['name: my brother, el Niño', 'Mi hermano, el Niño, llegó tarde.'],
  ['name: la Niña at the bakery', 'La Niña de la panadería es muy simpática.'],
  ['name: Chico as a nickname', 'Todos lo llamaban Chico por el apodo.'],
  ['quotes: love note on the mirror', 'Ella escribió "te quiero" en el espejo.'],
  ['quotes: a heart with her name', 'Dibujó un corazón con su nombre.'],
  ['asterisks: he smiled', '*Él sonrió* y ella se sonrojó.'],
  ['quotes: come here, quietly', 'Ella dijo bajito: "ven".'],
  ['name: Criança as a nickname', 'Su apodo es Criança porque es el más joven del grupo.'],
  ['name: María my neighbour', 'María, mi vecina, tiene un gato llamado Bigotes.'],
  ['accents missing: nina without a tilde', 'La nina de la tienda es simpática.'],
  ['all caps: my brother arrived late', 'MI HERMANO LLEGÓ TARDE.'],
  ['zero width inside a family word', 'Mi her\u200bmano llegó temprano.'],

  // ── adult scenes, none of the guarded words ──
  ['adult scene: neck kiss', 'Él le besó el cuello y ella suspiró.'],
  ['adult scene: undressed and held', 'Nos quitamos la ropa y nos quedamos abrazados en la cama.'],
  ['adult scene: hand on her back', 'Él le pasó la mano por la espalda despacio.'],
  ['adult scene: she bit her lip', 'Ella se mordió el labio y lo miró.'],
  ['adult scene: kissing on the sofa', 'Se besaron en el sofá hasta tarde.'],
  ['adult scene: whispered and laughed', 'Él le susurró al oído y ella se rió.'],
  ['adult scene: slept in each other’s arms', 'Dormimos abrazados toda la noche.'],
  ['adult scene: caressed her face', 'Él le acarició la cara con cariño.'],
  ['adult scene: on his lap', 'Ella se sentó en su regazo y el beso duró.'],
  ['adult scene: bodies close', 'Los cuerpos quedaron pegados en el calor de la noche.'],
  ['adult scene: pulled by the waist', 'Él la atrajo por la cintura y ella se entregó al beso.'],
  ['adult scene: heavy breathing', 'La respiración de los dos se volvió pesada.'],
  ['adult scene: shirt off', 'Él se quitó la camisa despacio y ella sonrió.'],
  ['adult scene: until sunrise', 'Nos quedamos en la cama hasta que salió el sol.'],
  ['adult scene: hand on his chest', 'Ella puso la mano en su pecho y sintió el corazón.'],
  ['adult scene: the long kiss', 'El beso fue largo y nadie quería parar.'],

  // ── words excluded on purpose ──
  ['excluded: pica of the pliers', 'La pica del alicate se rompió en la obra.'],
  ['excluded: verga of the boat', 'La verga del barco se quedó atrapada en la piedra.'],
  ['excluded: polla of the rooster', 'La polla del gallo cantó al amanecer.'],
  ['excluded: culo of the barrel', 'El culo del barril necesita arreglo.'],
  ['excluded: pene of the doll', 'El pene del muñeco es de plástico.'],
  ['excluded: pene of the baby', 'Ella habló del pene del bebé en la consulta.'],
  ['excluded: caralho inside Spanish', 'Él dijo caralho cuando se golpeó el dedo.'],
  ['excluded: joder with my brother', 'No joder con mi hermano, está cansado.'],
  ['excluded: chingar as a joke', 'En México, chingar puede ser broma entre amigos.'],
  ['excluded: coger the wrong bus', 'Ella no quiso coger el autobús equivocado.'],
  ['excluded: gozar on holiday', 'Gozar de las vacaciones es lo mejor.'],
  ['excluded: chupar an ice cream', 'Vamos a chupar un helado en la playa.'],
  ['excluded: trepar a tree', 'De niño solía trepar a los árboles.'],
  ['excluded: penetrar with care', 'El médico va a penetrar con cuidado en la zona.'],
  ['excluded: correrse before the meeting', 'No hace falta correrse para la reunión.'],
  ['excluded: comer a pizza', 'Vamos a comer una pizza hoy.'],
  ['excluded: pegar the bus', 'Intentó pegar el autobús corriendo.'],
  ['excluded: desnuda in the changing room', 'Ella se quedó desnuda en el vestuario y nadie la vio.'],
  ['excluded: desnuda at carnival', 'La playa estaba llena de gente desnuda en carnaval.'],
  ['excluded: violar the law', 'Violar la ley tiene consecuencias.'],
  ['excluded: violence against women', 'La violencia contra la mujer debe denunciarse.'],
  ['excluded: nua inside Spanish', 'Ella dijo que estaba nua en la playa.'],
  ['excluded: anos are years here', 'El sofá tiene tres anos y todavía está bien.'], // missing accents: "anos" = años

  // ── Portuguese inside a Spanish save ──
  ['portuguese inside es: my mother’s house', 'A casa da minha mãe está sempre cheia.'],
  ['portuguese inside es: my sister called', 'Minha irmã me ligou ontem e conversamos um pouco.'],
  ['portuguese inside es: her father', 'Ela disse que o pai dela estava bem.'],
  ['portuguese inside es: the boy and his cousin', 'O menino brinca no parque com o primo.'],
  ['portuguese inside es: see you tomorrow', 'A gente se vê amanhã, tenho que trabalhar.'],
  ['portuguese inside es: my aunt cooks', 'Minha tia cozinha melhor que minha mãe.'],
  ['portuguese inside es: her brother in Lisbon', 'O irmão dela mora em Lisboa.'],
  ['portuguese inside es: grandma’s stories', 'A avó conta histórias de quando era jovem.'],
  ['portuguese inside es: my cousin visits', 'Minha prima vem nos visitar no mês que vem.'],
  ['portuguese inside es: the priest', 'O padre da igreja falou com os jovens.'],
  ['portuguese inside es: all caps at home', 'A GENTE TRANSOU NA CASA DA MINHA IRMÃ.'],
  ['a plural minor noun needs a plural article', 'Él folló con niños.'],
  ['in-law at her house and the act', 'Tuvimos sexo en casa de mi suegra.'],
  ['in-law as the object', 'Tuvimos sexo con mi cuñada.'],
  ['religious title: Father Juan', 'Tuvimos sexo con el Padre Juan.'],
  ['vocative sister after the act', 'Tuvimos sexo, mi hermana, ya hablamos.'],
  ['assurance of majority in Spanish', 'No eres menor de edad, podemos tener sexo.'],
  ['minor noun alone: chica', 'Él folló con la chica.'],
  ['minor noun alone: nena', 'Él folló con la nena.'],
  ['minor noun alone: bebé', 'Él folló con la bebé.'],
  ['excluded body part: cu', 'Le dolía el cu y fue al médico.'],
  ['excluded nudity: pelada', 'La playa estaba llena de gente pelada en carnaval.'],
  ['excluded violence: estuprar', 'La policía detuvo al hombre que intentó estuprar a la vecina.'],
  ['portuguese inside es: I like how you speak', 'Eu gosto quando você fala assim comigo.'],
  ['shared words: my cousin and my uncle', 'Mi prima y mi tío vinieron a cenar.'],
  ['shared words: the orgasm is not the goal', 'El orgasmo no es la única cosa que importa.'],

  // ── p2: the owner of the relative must be the one acting ──
  ['p2 you slept with my sister', 'Follaste con mi hermana.'],
  ['p2 tú form, my sister', 'Tú follaste con mi hermana.'],
  ['p2 my wife with my brother', 'Mi esposa folló con mi hermano.'],
  ['p2 my husband with my sister', 'Descubrí que mi marido folló con mi hermana.'],
  ['p2 my brother with his girlfriend', 'Mi hermano folló con su novia.'],
  ['p2 my sister with her boyfriend', 'Mi hermana folló con su novio.'],
  ['p2 a guy, not an uncle', 'Follé con un tío.'],
  ['p2 a guy from work, not an uncle', 'Follé con un tío de mi trabajo.'],
  ['p2 his own sister, reported', 'Ella contó que folló con su hermano.'],
  ['p2 the neighbour and his sister', 'Mi vecino folló con su hermana.'],
  ['p2 my brother, person reported', 'Mi hermano dijo que folló con su prima.'],
  ['p2 she slept with my brother', 'Ella folló con mi hermano.'],
  ['p2 my friend’s cousin', 'Follamos con el primo de mi amiga.'],
  ['p2 the sister of my neighbour', 'Follé con la hermana de mi vecina.'],
  ['p2 he slept with your sister (no tú marker)', 'Él folló con tu hermana, no con la mía.'],
  ['p2 his brother and hers', 'Folló con su hermano, el de ella.'],
  ['p2 your sister, not mine', 'Folló con tu hermana, no con la mía.'],
  ['p2 the daughter of the neighbour', 'Folló con la hija del vecino.'],
  ['p2 at her mother’s, act beside it', 'Follamos en casa de su madre.'],
  ['p2 she with a guy', 'Ella folló con un tío.'],
  ['p2 they with a guy', 'Follaron con un tío.'],
  ['p2 nobody with my sister', 'Nadie folló con mi hermana, es seria.'],
  ['p2 usted takes third-person forms', 'Usted folló con su hermana.'],

  // ── moved from rl-s blocked: third person + su is clear (point 2) ──
  ['moved rl-s: his sister', 'Él folló con su hermana.'],
  ['moved rl-s: his daughter', 'Él folló con su hija.'],
  ['moved rl-s: his father', 'Él folló con su padre.'],
  ['moved rl-s: his son', 'Él folló con su hijo.'],
  ['moved rl-s: his grandmother', 'Él folló con su abuela.'],
  ['moved rl-s: his grandfather', 'Él folló con su abuelo.'],
  ['moved rl-s: his nephew', 'Él folló con su sobrino.'],
  ['moved rl-s: his stepmother', 'Él folló con su madrastra.'],
  ['moved rl-s: his stepfather', 'Él folló con su padrastro.'],
  ['moved rl-s: his stepdaughter', 'Él folló con su hijastra.'],
  ['moved rl-s: his stepson', 'Él folló con su hijastro.'],
  ['moved rl-s: his stepsister', 'Él folló con su hermanastra.'],
  ['moved rl-s: his stepbrother', 'Él folló con su hermanastro.'],
  ['moved rl-s: his cousins plural', 'Él folló con sus primas.'],
  ['moved rl-s: his brothers plural', 'Él folló con sus hermanos.'],
  ['moved rl-s: his parents plural', 'Él folló con sus padres.'],
  ['moved rl-s: his uncles plural', 'Él folló con sus tíos.'],
  ['moved rl-s: personal a with su', 'Él folló a su hermana.'],
  ['moved rl-s: no connector with su', 'Él folló su hermana.'],
  ['moved rl-s: one token then con su', 'Él folló hoy con su hermana.'],
  ['moved rl-s: his sisters plural', 'Él folló con sus hermanas.'],
  ['moved rl-s: his daughters plural', 'Él folló con sus hijas.'],
  ['moved rl-s: his aunts plural', 'Él folló con sus tías.'],
  ['moved rl-s: his grandmothers plural', 'Él folló con sus abuelas.'],
  ['moved rl-s: his stepmothers plural', 'Él folló con sus madrastras.'],
  ['moved rl-s: his nieces plural', 'Él folló con sus sobrinas.'],
  ['moved rl-s: follaban with su', 'Follaban con su prima.'],
  ['moved rl-s: follándose with su', 'Follándose con su hermana.'],
  ['moved rl-s: folló with su', 'Folló con su hermana.'],
  ['moved rl-s: folla with su', 'Ella folla con su padre.'],
  ['moved rl-s: masturbarse with su', 'Masturbarse con su hermana.'],
  ['moved rl-s: se masturba with su', 'Él se masturba con su madre.'],
  ['moved rl-s: masturbando with su', 'Masturbando a su madre.'],
  ['moved rl-s: eyaculó with su', 'Eyaculó con su madre.'],
  ['moved rl-s: eyaculando with su', 'Eyaculando con su hermana.'],
  ['moved rl-s: folló with la hija', 'Él folló a la hija.'],
  ['moved rl-s: folló with la hermana', 'Él folló la hermana.'],
  ['moved rl-s: follando with su', 'Él follando con su tía.'],
  ['moved rl-s: follaba with su', 'Él follaba con su prima.'],
  ['moved rl-s: third person plural, his sister', 'Ellos follan con su hermana.'],
  ['moved rl-s: accent-less aunt, his', 'Él folló con su tia.'],
  ['moved rl-s: accent-less uncle, his', 'Él folló con su tio.'],
  ['moved rl-s: zero width inside su hermana', 'Él folló con su her\u200bmana.'],
  ['moved rl-s: asterisks around the line', '*Él folló con su hermana*'],
  ['moved rl-s: quoted su hermana', 'Él folló con su "hermana".'],
  ['moved rl-s: zero width after su hermana', 'Él folló con su hermana\u200d.'],
  ['moved rl-s: Loli is a name', 'Loli, él folló con ella.'],

  // ── p3: denial is clear ──
  ['p3 never with my sister', 'Nunca follé con mi hermana.'],
  ['p3 never with my cousin', 'Jamás tuve sexo con mi prima.'],
  ['p3 I do not have sex with my cousins', 'No tengo sexo con mis primas.'],
  ['p3 I did not sleep with your sister', 'No follé con tu hermana.'],
  ['p3 she never slept with my brother', 'Ella nunca folló con mi hermano.'],
  ['p3 we never slept with our cousins', 'Nunca follamos con nuestros primos.'],
  ['p3 I do not want to', 'No quiero follar con mi hermana.'],
  ['p3 never, long form', 'Yo nunca voy a follar con mi hermana.'],

  // ── p4: someone else nearby is clear ──
  ['p4 parents with the children asleep', 'Hicimos el amor con las niñas durmiendo en la habitación de al lado.'],
  ['p4 children asleep, act first', 'Tuvimos sexo con los niños durmiendo.'],
  ['p4 while the children slept', 'Los niños dormían y nosotros follamos.'],
  ['p4 the children asleep at home', 'Follamos con los niños en casa y nadie se despertó.'],
  ['p4 children at home', 'Tuvimos sexo con los niños en casa, bajito.'],
  ['p4 boys asleep in the next room', 'Tuvimos sexo con los niños dormidos en el cuarto de al lado.'],
  ['p4 sister asleep beside us', 'Follé con mi hermana durmiendo en la cama de al lado.'],

  // ── p5: talking about it is clear ──
  ['p5 about sex with his own sister', 'Hablamos sobre sexo con su propia hermana y fue incómodo.'],
  ['p5 talked about it, de + speech verb', 'Hablamos de sexo con su propia hermana.'],
  ['p5 about sex and the children', 'Hablamos sobre sexo con los niños en la escuela.'],

  // ── p6: Loli is a name ──
  ['p6 Loli is a name, with an act', 'Loli y yo follamos toda la noche.'],
  ['p6 Loli is a name, no act', 'Loli, mi vecina, cumplió cuarenta años.'],
  ['p6 Loli is a name, reported', 'Le conté a Loli que follamos en la playa.'],

  // ── p7: stated age, leniency ──
  ['p7 five years without sex', 'Tengo 5 años sin tener sexo.'],
  ['p7 five years without sleeping with anyone', 'Tengo 5 años sin follar.'],
  ['p7 ten years more than me', 'Ella tiene 10 años más que yo y follamos igual.'],
  ['p7 ten years more, no act', 'Ella tiene 10 años más que yo.'],
  ['p7 eight years of dating', 'Tiene 8 años que nos conocemos y follamos.'],
  ['p7 ages 40 and 28', 'Tengo 40 años y ella tiene 28, y follamos genial.'],
  ['p7 twenty years together', 'Follamos los dos hace 20 años y aquí seguimos.'],
  ['p7 relationship is the subject', 'Mi relación tiene 6 años y follamos como siempre.'],
  ['p7 house is the subject', 'Mi casa tiene 6 años y follamos aquí todos los días.'],
  ['p7 possessed child, not in the act', 'Mi hijo tiene 5 años y casi no follamos.'],
  ['p7 with a comma after the age', 'Tengo 30 años, y follamos cuando podemos.'],
  ['p7 years since the last time, plural', 'Tengo años sin follar y quiero volver.'],
  ['p7 ten years of marriage, the act after', 'Tenemos 10 años de casados y follamos mejor que antes.'],

  // ── p8: coded terms, each occurrence alone ──
  ['p8 nobody is a minor here', 'Aquí nadie es menor de edad, vamos a follar.'],
  ['p8 not a minor, assurance', 'No soy menor de edad, podemos follar.'],
  ['p8 nobody is underage, long', 'Aquí no hay ningún menor de edad, vamos a follar.'],
  ['p8 we are all adults', 'Todos somos mayores de edad y queremos follar.'],

  // ── p8: each coded occurrence judged alone, one negated and one not ──
  ['p8 one negated coded term, another clear', 'Nadie aquí es menor de edad y Loli cumplió treinta.'],
  ['p8 coded term in a denial about the past', 'Nunca hubo una loli en esta historia.'],
  ['p8 age of consent discussed, adults', 'Somos mayores de edad y sabemos lo que hacemos.'],
]

// ── Spanish, must block ────────────────────────────────────────────────────────

const ES_BLOCKED: readonly BlockCase[] = [
  // ── p2: first-person forms with the first-person possessive ──
  ['p2 I slept with my sister', 'Follé con mi hermana.', 'incest'],
  ['p2 I sleep with my mother', 'Yo follo con mi madre.', 'incest'],
  ['p2 we slept with my brother', 'Follamos con mi hermano.', 'incest'],
  ['p2 I made love with my sister', 'Hice el amor con mi hermana.', 'incest'],
  ['p2 we made love with our cousin', 'Hicimos el amor con nuestra prima.', 'incest'],
  ['p2 I had sex with my uncle', 'Tuve sexo con mi tío.', 'incest'],
  ['p2 we had sex with my brother', 'Tuvimos sexo con mi hermano.', 'incest'],
  ['p2 I have sex with my cousin', 'Tengo sexo con mi prima.', 'incest'],
  ['p2 I masturbated with my sister', 'Me masturbé con mi hermana.', 'incest'],
  ['p2 I fucked my sister', 'Me follé a mi hermana.', 'incest'],
  ['p2 I masturbate my son', 'Masturbo a mi hijo.', 'incest'],
  ['p2 I ejaculated with my mother', 'Eyaculé con mi madre.', 'incest'],
  ['p2 my sisters, first person', 'Follé con mis primas.', 'incest'],
  ['p2 my parents, first person', 'Follé con mis padres.', 'incest'],
  ['p2 my sisters, made love', 'Hice el amor con mis hermanas.', 'incest'],

  // ── p2: infinitive with a first-person marker ──
  ['p2 I want to fuck my sister', 'Yo quiero follar con mi hermana.', 'incest'],
  ['p2 I am going to fuck my sister', 'Voy a follar con mi hermana.', 'incest'],
  ['p2 let us have sex with my cousin', 'Vamos a tener sexo con mi prima.', 'incest'],
  ['p2 I need to make love with my sister', 'Necesito hacer el amor con mi hermana.', 'incest'],
  ['p2 I want to fuck my mother', 'Quiero follar con mi madre.', 'incest'],

  // ── p2: own-relative with propia ──
  ['p2 his own sister', 'Él folló con la propia hermana.', 'incest'],
  ['p2 his own daughter', 'Ella folla con la propia hija.', 'incest'],
  ['p2 his own sister with su', 'Él folló con su propia hermana.', 'incest'],
  ['p2 sexo con, own sister', 'Sexo con mi hermana.', 'incest'],

  // ── p2: second person ──
  ['p2 you slept with your sister', 'Follaste con tu hermana.', 'incest'],
  ['p2 tú, your mother', 'Tú follaste con tu madre.', 'incest'],
  ['p2 you sleep with your cousin', 'Follas con tu prima.', 'incest'],
  ['p2 you masturbate your sister', 'Masturbas a tu hermana.', 'incest'],
  ['p2 imperative with your sister', 'Fóllate a tu hermana.', 'incest'],

  // ── p7: stated age with de edad, and minors ──
  ['p7 fifteen with de edad', 'Tengo 15 años de edad y follo con ella.', 'minor_sexual'],
  ['p7 fifteen, plain', 'Tengo 15 años y follo con él.', 'minor_sexual'],
  ['p7 she is fourteen', 'Ella tiene 14 años y folló con él.', 'minor_sexual'],
  ['p7 sixteen, first person', 'Tengo dieciséis años y quiero follar.', 'minor_sexual'],
  ['p7 girl with a digit age', 'Él tuvo sexo con la niña de 12 años.', 'minor_sexual'],
  ['p7 boy with a digit age', 'Él folló con el niño de 8 años.', 'minor_sexual'],
  ['p7 young woman with an age', 'Él folló con la chica de 15 años.', 'minor_sexual'],
  ['p7 menor de edad', 'Él folló con la menor de edad.', 'minor_sexual'],
  ['p7 adolescents plural', 'Él folló con los adolescentes.', 'minor_sexual'],
  ['p7 girls with a plural article', 'Él folló con las niñas.', 'minor_sexual'],
  ['p7 adolescent singular', 'Él folló con la adolescente.', 'minor_sexual'],
  ['p7 Loli with an indefinite article', 'Él folló con una Loli.', 'minor_sexual'],
  ['p7 loli lowercase', 'loli, él folló con ella.', 'minor_sexual'],
  ['p7 lolicon', 'Lolicon, follar.', 'minor_sexual'],
  ['p7 shotacon', 'Shotacon, sexo oral.', 'minor_sexual'],
  ['p7 girl with an age after a comma', 'Él folló con la niña, 11 años.', 'minor_sexual'],

  // ── p8: a negator that the clause turns around does not clear ──
  ['p8 without her being a minor', 'Sin que sea menor de edad, quiero follar.', 'minor_sexual'],

  // ── review: the minor acts, and a desire that won't stop ──
  ['review minors acting', 'Quiero ver a dos niños follando.', 'minor_sexual'],
  ['review cannot stop', 'No puedo dejar de follar con mi hermana.', 'incest'],

  // ── missing accents ──
  ['accent-less aunt', 'Follé con mi tia.', 'incest'],
  ['accent-less uncle', 'Follé con mi tio.', 'incest'],

  // ── obfuscation ──
  ['all caps', 'SEXO CON MI HERMANA.', 'incest'],
  ['asterisks around the line', '*Follé con mi hermana*', 'incest'],
  ['zero width inside the family word', 'Follé con mi her\u200bmana.', 'incest'],
  ['quoted family word', 'Follé con mi "hermana".', 'incest'],
  ['zero width after the family word', 'Follé con mi hermana\u200d.', 'incest'],

  // ── more act forms, first person ──
  ['follaba with yo', 'Yo follaba con mi hermana.', 'incest'],
  ['follarme with mi', 'Follarme con mi hermana.', 'incest'],
  ['fóllame with mi', 'Fóllame con mi hermana.', 'incest'],
  ['orgasmo at the clause start', 'Orgasmo con mi prima.', 'incest'],
  ['orgía at the clause start', 'Orgía con mis hermanas.', 'incest'],
  ['eyacular at the clause start', 'Eyacular con mi tía.', 'incest'],
  ['hacer el amor at the clause start', 'Hacer el amor con mi madre.', 'incest'],
  ['sexo oral at the clause start', 'Sexo oral con mi madre.', 'incest'],
  ['sexo anal at the clause start', 'Sexo anal con mi hermano.', 'incest'],
  ['one token then con, first person', 'Follé hoy con mi hermana.', 'incest'],
  ['no connector, first person', 'Yo follé mi hermana.', 'incest'],

  // ── every remaining rl-s blocked line, kept where it was (point 10) ──
  ['rl-s: clitic with cousin', 'Follarte con tu prima.', 'incest'],
  ['rl-s: masturbarme with aunt', 'Masturbarme con mi tía.', 'incest'],
  ['rl-s: tuvimos sexo with sister', 'Tuvimos sexo con mi hermana.', 'incest'],
  ['rl-s: tengo sexo with mother', 'Tengo sexo con mi madre.', 'incest'],
  ['rl-s: tener sexo with father', 'Tener sexo con mi padre.', 'incest'],
  ['rl-s: teniendo sexo with cousin', 'Teniendo sexo con mi prima.', 'incest'],
  ['rl-s: hicimos el amor with sister', 'Hicimos el amor con mi hermana.', 'incest'],
  ['rl-s: hago el amor with aunt', 'Hago el amor con mi tía.', 'incest'],
  ['rl-s: haciendo el amor with cousin', 'Haciendo el amor con mi prima.', 'incest'],
  ['rl-s: hice el amor with niece', 'Hice el amor con mi sobrina.', 'incest'],
  ['rl-s: boy with eight', 'Él tuvo sexo con el niño de 8 años.', 'minor_sexual'],
  ['rl-s: chico with sixteen', 'Él folló con el chico de 16 años.', 'minor_sexual'],
  ['rl-s: plural boys', 'Él folló con los niños.', 'minor_sexual'],
  ['rl-s: plural boys with unos', 'Él folló con unos niños.', 'minor_sexual'],
  ['rl-s: menores de edad', 'Él folló con menores de edad.', 'minor_sexual'],
  ['rl-s: first person stated age', 'Tengo 14 años y follo con él.', 'minor_sexual'],
  ['rl-s: third person stated age', 'Ella tiene 15 años y folló con él.', 'minor_sexual'],
  ['rl-s: word age', 'Él tiene doce años y tuvimos sexo.', 'minor_sexual'],
  ['rl-s: word age, first person', 'Tengo dieciséis años y quiero follar contigo.', 'minor_sexual'],
  ['rl-s: reported age', 'Él dijo que tiene 13 años y folló.', 'minor_sexual'],
  ['rl-s: shota with an act', 'Shota, él folló.', 'minor_sexual'],
  ['rl-s: girl with a word age', 'Él folló con la niña de once años.', 'minor_sexual'],
  ['rl-s: boy with a word age', 'Él folló con el chico de diez años.', 'minor_sexual'],
  ['rl-s: accent-less girl and years', 'Él folló con la nina de 12 anos.', 'minor_sexual'],
  ['rl-s: follé past', 'Follé con mi madre.', 'incest'],
  ['rl-s: tener sexo', 'Tener sexo con mi hermana.', 'incest'],
  ['rl-s: tuve sexo', 'Tuve sexo con mi madre.', 'incest'],
  ['rl-s: hice el amor', 'Hice el amor con mi prima.', 'incest'],
]

// ── harness ───────────────────────────────────────────────────────────────────

let pass = 0
let fail = 0
const only = process.env.GUARD_AUDIT_ONLY ?? ''

async function check(label: string, fn: () => Promise<void> | void) {
  if (only && !label.includes(only)) return
  try {
    await fn()
    pass++
    console.log(`  ok   ${label}`)
  } catch (error) {
    fail++
    console.log(`  FAIL ${label}\n       ${(error as Error).message}`)
  }
}

async function clearCases(language: 'pt' | 'es', cases: readonly ClearCase[]) {
  for (const [why, text] of cases) {
    await check(`${language} clear: ${why}`, () => {
      const verdict = screenPlayerInputIn(language, text)
      assert.equal(verdict.blocked, false, `blocked as ${verdict.category}`)
    })
  }
}

async function blockedCases(language: 'pt' | 'es', cases: readonly BlockCase[]) {
  for (const [why, text, category] of cases) {
    await check(`${language} blocked: ${why}`, () => {
      const verdict = screenPlayerInputIn(language, text)
      assert.equal(verdict.blocked, true, 'expected a block')
      assert.equal(verdict.category, category)
      assert.equal(verdict.message, GUARD_MESSAGES[category])
    })
  }
}

await clearCases('pt', PT_CLEAR)
await clearCases('es', ES_CLEAR)
await blockedCases('pt', PT_BLOCKED)
await blockedCases('es', ES_BLOCKED)

const pointCases = (cases: readonly ClearCase[]) => cases.filter(([why]) => /^p[2-8] /.test(why)).length

await check('corpus size: at least 150 clear and 30 blocked per language', () => {
  assert.ok(PT_CLEAR.length >= 150, `Portuguese clear set has ${PT_CLEAR.length}`)
  assert.ok(ES_CLEAR.length >= 150, `Spanish clear set has ${ES_CLEAR.length}`)
  assert.ok(PT_BLOCKED.length >= 30, `Portuguese blocked set has ${PT_BLOCKED.length}`)
  assert.ok(ES_BLOCKED.length >= 30, `Spanish blocked set has ${ES_BLOCKED.length}`)
})

await check('corpus size: at least 60 clear lines per language on points 2 to 8', () => {
  assert.ok(pointCases(PT_CLEAR) >= 60, `Portuguese has ${pointCases(PT_CLEAR)} labelled point cases`)
  assert.ok(pointCases(ES_CLEAR) >= 60, `Spanish has ${pointCases(ES_CLEAR)} labelled point cases`)
})

await check('corpus coverage: every point 2 to 8 has clear cases in both languages', () => {
  for (const [language, cases] of [['pt', PT_CLEAR], ['es', ES_CLEAR]] as const) {
    for (const point of [2, 3, 4, 5, 6, 7, 8]) {
      const count = cases.filter(([why]) => why.startsWith(`p${point} `)).length
      assert.ok(count > 0, `${language} has no clear case for point ${point}`)
    }
  }
})

await check('English save: every Portuguese and Spanish clear sentence is clear through screenPlayerInput', () => {
  const offenders = [...PT_CLEAR.map((entry) => ['pt', entry] as const), ...ES_CLEAR.map((entry) => ['es', entry] as const)]
    .map(([language, [why, text]]) => ({ language, why, text, verdict: screenPlayerInput(text) }))
    .filter((entry) => entry.verdict.blocked)
  assert.deepEqual(
    offenders.map((entry) => `${entry.language} ${entry.why} (${entry.verdict.category})`),
    [],
    `the English guard blocks clear foreign sentences: ${offenders.map((entry) => JSON.stringify(entry.text)).join(', ')}`,
  )
})

await check('cross-pack: the Portuguese clear set is clear in Spanish', () => {
  const offenders = PT_CLEAR.filter(([, text]) => screenPlayerInputIn('es', text).blocked)
  assert.deepEqual(offenders.map(([why]) => why), [])
})

await check('cross-pack: the Spanish clear set is clear in Portuguese', () => {
  const offenders = ES_CLEAR.filter(([, text]) => screenPlayerInputIn('pt', text).blocked)
  assert.deepEqual(offenders.map(([why]) => why), [])
})

await check('pack choice: unknown and English languages stay clear', () => {
  const text = 'vou transar com minha irmã'
  for (const language of ['en', 'en-US', 'fr', 'de', 'constructor', 'toString', undefined, null]) {
    assert.equal(screenPlayerInputIn(language, text).blocked, false, `${String(language)} must be clear`)
  }
  assert.equal(screenPlayerInputIn('pt-BR', text).blocked, true, 'a Portuguese locale uses the Portuguese pack')
})

await check('pack isolation: an English act word stays clear in Portuguese', () => {
  assert.equal(screenPlayerInputIn('pt', 'teve sex com minha irmã').blocked, false)
  assert.equal(screenPlayerInputIn('pt', 'I had sex with my sister').blocked, false)
  assert.equal(screenPlayerInputIn('es', 'I had sex with my sister').blocked, false)
})

await check('verdicts: never carry the text', () => {
  for (const [language, text] of [['pt', 'Eu transei com minha irmã.'], ['pt', 'Tudo bem.'], ['es', 'Follé con mi hermana.'], ['es', 'Todo bien.']] as const) {
    const verdict = screenPlayerInputIn(language, text)
    assert.deepEqual(Object.keys(verdict).sort(), verdict.blocked ? ['blocked', 'category', 'message'] : ['blocked'])
    assert.equal(JSON.stringify(verdict).includes(text), false, 'the verdict carries the player text')
  }
})

await check('dispatch: screens in the save language after the session loads', async () => {
  const source = await readFile(new URL('../src/services/generation.service.ts', import.meta.url), 'utf8')
  const load = source.indexOf('const session = await instanceService.loadSession(instanceId, playerId)')
  const screen = source.indexOf('const languageVerdict = screenPlayerInputIn(session.reply_language, userMessage)')
  const thrown = source.indexOf('if (languageVerdict.blocked) throw new HttpError(400, languageVerdict.message!)')
  assert.ok(load > 0, 'the session load is missing')
  assert.ok(screen > load, 'the language screen must run after the session loads')
  assert.ok(thrown > screen, 'the language verdict must throw the same 400')
})

if (fail > 0) {
  console.log(`\ninput-guard-languages audit: ${pass} passed, ${fail} failed`)
  process.exit(1)
}

if (process.argv.includes('--bites')) {
  await runBites()
} else {
  console.log(
    `\ninput-guard-languages audit: ${pass} passed, 0 failed` +
      ` (pt clear ${PT_CLEAR.length}, pt blocked ${PT_BLOCKED.length}, es clear ${ES_CLEAR.length},` +
      ` es blocked ${ES_BLOCKED.length}; point cases pt ${pointCases(PT_CLEAR)}, es ${pointCases(ES_CLEAR)})`,
  )
}

// ── bites ─────────────────────────────────────────────────────────────────────

type Edit = [file: string, from: string, to: string]
type Mutation = { name: string; check: string; edits: Edit[] }

async function runBites() {
  const root = await mkdtemp(join(import.meta.dir, '.input-guard-languages-bites-'))
  const server = new URL('..', import.meta.url).pathname
  const AUDIT = 'scripts/input-guard-languages-audit.ts'
  const guard = 'src/utils/input-guard.ts'
  const packs = 'src/utils/input-guard-languages.ts'
  const dispatch = 'src/services/generation.service.ts'

  const mutations: Mutation[] = [
    // 1. a possessive is required before a family noun
    {
      name: 'family: a family noun is an object without a possessive',
      check: 'pt clear: moved rl-s: sister, no possessive',
      edits: [[packs, 'if (!ref.own && !ref.possessive) return false', 'if (!ref.own && !ref.possessive) return true']],
    },
    // 2. the owner of the relative must be the one acting
    {
      name: 'owner: any first-person possessive blocks, whoever acts',
      check: 'pt clear: p2 my wife slept with my brother',
      edits: [[packs, 'if (pack.firstPoss.has(possessive)) {\n    if (match.person === \'first\') return true', 'if (pack.firstPoss.has(possessive)) {\n    return true\n    if (match.person === \'first\') return true']],
    },
    {
      name: 'owner: an open act counts as first person',
      check: 'pt clear: p2 I saw him with my sister',
      edits: [[packs, "if (match.person === 'open') return opensClause(tokens, match) || markerGoverns(pack, tokens, match)", "if (match.person === 'open') return true"]],
    },
    {
      name: 'owner: the ter auxiliary hides the first-person marker',
      check: 'pt blocked: p2 I had been sleeping with my sister',
      edits: [[packs, 'if (pack.terAux.has(tokens[i].text)) continue\n    if (!LIGHT.has(tokens[i].text)) return false', 'if (!LIGHT.has(tokens[i].text)) return false']],
    },
    {
      name: 'owner: a second-person possessive blocks any act',
      check: 'pt clear: p2 your sister, he slept with her',
      edits: [[packs, 'if (pack.secondPoss.has(possessive)) return match.person === \'second\'', 'if (pack.secondPoss.has(possessive)) return true']],
    },
    // 3. denial is clear
    {
      name: 'denial: a negator no longer clears the act',
      check: 'pt clear: p3 never with my sister',
      edits: [[packs, 'for (let j = i + 1; j < match.start; j++) if (DENIAL_STOPPERS.has(tokens[j].text)) return false\n    return true', 'for (let j = i + 1; j < match.start; j++) if (DENIAL_STOPPERS.has(tokens[j].text)) return false\n    return false']],
    },
    // 4. someone else nearby is clear
    {
      name: 'elsewhere: a gerund no longer clears the minor',
      check: 'pt clear: p4 parents with the children asleep',
      edits: [[packs, 'if (GERUND.test(word) && !NOT_GERUNDS.has(word)) return true', 'if (false) return true']],
    },
    // 5. talking about it is clear
    {
      name: 'talking: sobre sexo is read as an act',
      check: 'pt clear: p5 about sex with his own sister',
      edits: [[packs, "if (before.text === 'sobre') return true", 'if (false) return true']],
    },
    {
      name: 'talking: de with a speech verb is read as an act',
      check: 'es clear: p5 talked about it, de + speech verb',
      edits: [[packs, 'if (tokens[i].segment === match.segment && SPEECH_VERBS.has(tokens[i].text)) return true', 'if (false) return true']],
    },
    // 6. code words removed or narrowed
    {
      name: 'loli: a capitalised name is a coded term',
      check: 'es clear: p6 Loli is a name, with an act',
      edits: [[packs, "return /(?:^|\\s)(?:un|una)\\s+$/i.test(before) ? word : ' '", 'return word']],
    },
    {
      name: 'idiom: me fodi is read as an act',
      check: 'pt clear: foder idiom: me fodi',
      edits: [[packs, "['se', 'fodeu'], ['me', 'fodi'],", "['se', 'fodeu'],"]],
    },
    // 7. stated age
    {
      name: 'age: anything after the unit counts as an age',
      check: 'es clear: p7 five years without sex',
      edits: [[packs, 'const counts = !sameClause || pack.ageFollows.has(after!.text) ||', 'const counts = true ||']],
    },
    {
      name: 'age: de idade is not read',
      check: 'pt blocked: p7 fifteen with de idade',
      edits: [[packs, "(after!.text === 'de' && tokens[i + 4]?.text === pack.ageOfMinor && tokens[i + 4]!.segment === tokens[i].segment)", 'false']],
    },
    {
      name: 'age: a possessed child counts without an act on the child',
      check: 'es clear: p7 possessed child, not in the act',
      edits: [[packs, 'if (possessedChild && !pronounAfterAct(tokens, acts)) continue', 'if (false) continue']],
    },
    {
      name: 'age: a relationship or house as the subject counts',
      check: 'es clear: p7 relationship is the subject',
      edits: [[packs, 'if (pack.ageThirdPerson.has(tokens[i].text) && subjectInClause && THING_SUBJECTS.has(subject!.text)) continue', 'if (false) continue']],
    },
    // 8. coded terms, each occurrence judged alone
    {
      name: 'coded: a nearby negator no longer clears the occurrence',
      check: 'pt clear: p8 nobody is a minor here',
      edits: [[packs, 'if (pack.codedNegators.has(tokens[i].text)) return true', 'if (false) return true']],
    },
    {
      name: 'coded: que/se/si no longer turn the negation around (es)',
      check: 'es blocked: p8 without her being a minor',
      edits: [[packs, 'if (CODED_BLOCKERS.has(tokens[i].text)) return false\n    if (pack.codedNegators', 'if (false) return false\n    if (pack.codedNegators']],
    },
    {
      name: 'coded: que/se/si no longer turn the negation around (pt)',
      check: 'pt blocked: p8 without her being a minor',
      edits: [[packs, 'if (CODED_BLOCKERS.has(tokens[i].text)) return false\n    if (pack.codedNegators', 'if (false) return false\n    if (pack.codedNegators']],
    },
    {
      name: 'review: a minor acting is not read',
      check: 'pt blocked: review minors acting',
      edits: [[packs, "if (minorActs(pack, tokens, match)) return verdict('minor_sexual')", '']],
    },
    {
      name: 'review: parar hides the first-person marker',
      check: 'pt blocked: review cannot stop',
      edits: [[packs, "'seguir', 'parar', 'deixar', 'dejar',", "'seguir',"]],
    },
    // 9. English son
    {
      name: 'english: son is kinship in every reading',
      check: 'English save: every Portuguese and Spanish clear sentence is clear through screenPlayerInput',
      edits: [[guard, 'SON_WITH_DETERMINER.test(normalized)', 'true']],
    },
    // 10. everything else in rl-s stays
    {
      name: 'pack choice: an unknown language runs the Portuguese pack',
      check: 'pack choice: unknown and English languages stay clear',
      edits: [[packs, 'const pack = PACKS.get(code)', 'const pack = PACKS.get(code) ?? PT']],
    },
    {
      name: 'pack isolation: an English act word enters the Portuguese pack',
      check: 'pack isolation: an English act word stays clear in Portuguese',
      edits: [[packs, "'transo', 'transamos'", "'transo', 'sex', 'transamos'"]],
    },
    {
      name: 'normalization: zero-width characters survive',
      check: 'pt blocked: zero width inside the family word',
      edits: [[packs, 'const ZERO_WIDTH = /[\\u200b-\\u200d\\ufeff]/g', 'const ZERO_WIDTH = /(?!)/g']],
    },
    {
      name: 'normalization: case is not folded',
      check: 'pt blocked: all caps',
      edits: [[packs, '.toLowerCase()', '.toUpperCase()']],
    },
    {
      name: 'tokens: family words match inside longer words',
      check: 'pt clear: act with my sisterhood, own word',
      edits: [[packs, 'pack.family.has(tokens[ref.nounIndex].text)', '[...pack.family].some((word) => tokens[ref.nounIndex].text.includes(word))']],
    },
    {
      name: 'verdicts: a verdict carries the text',
      check: 'verdicts: never carry the text',
      edits: [[packs, 'return { blocked: true, category, message: GUARD_MESSAGES[category] }', "return { blocked: true, category, message: GUARD_MESSAGES[category], text: 'leak' } as GuardVerdict"]],
    },
    {
      name: 'dispatch: the language verdict does not throw',
      check: 'dispatch: screens in the save language after the session loads',
      edits: [[dispatch, 'if (languageVerdict.blocked) throw new HttpError(400, languageVerdict.message!)', 'void languageVerdict']],
    },
  ]

  const originals = new Map<string, string>()
  for (const file of [guard, packs, dispatch, AUDIT]) originals.set(file, await readFile(join(server, file), 'utf8'))

  try {
    for (const file of [guard, packs, dispatch, AUDIT]) {
      await mkdir(dirname(join(root, file)), { recursive: true })
      await cp(join(server, file), join(root, file))
    }
    await symlink(join(server, 'node_modules'), join(root, 'node_modules'), 'dir')

    let bitten = 0
    for (const mutation of mutations) {
      const changed = new Map<string, string>()
      try {
        for (const [file, from, to] of mutation.edits) {
          const path = join(root, file)
          const text = changed.get(file) ?? await readFile(path, 'utf8')
          assert.ok(text.includes(from), `${mutation.name}: mutation target missing: ${from}`)
          const next = text.replaceAll(from, to)
          changed.set(file, next)
          await writeFile(path, next)
        }
        const child = Bun.spawn(['bun', '--no-env-file', 'run', AUDIT], {
          cwd: root,
          env: { ...process.env, GUARD_AUDIT_ONLY: mutation.check },
          stdout: 'pipe',
          stderr: 'pipe',
          stdin: 'ignore',
        })
        const timer = setTimeout(() => child.kill(9), 60_000)
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        clearTimeout(timer)
        assert.notEqual(code, 0, `${mutation.name}: the audit accepted the broken packs\n${stdout}`)
        assert.ok(
          `${stdout}${stderr}`.includes(`FAIL ${mutation.check}`),
          `${mutation.name}: failed outside the intended check\n${stdout}\n${stderr}`,
        )
        bitten++
        console.log(`BITE ${mutation.name}: exit ${code}; FAIL ${mutation.check}`)
      } finally {
        for (const [file, text] of originals) await writeFile(join(root, file), text)
      }
    }

    // The originals were never the mutants; prove they are byte for byte what
    // the run started with.
    for (const [file, text] of originals) assert.equal(await readFile(join(server, file), 'utf8'), text, `${file} changed`)
    console.log(`input-guard-languages bites: ${bitten}/${mutations.length} mutations rejected; originals byte-identical`)
    if (bitten !== mutations.length) process.exit(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
