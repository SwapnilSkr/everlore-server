/**
 * THE LIVE TURN OF A NON-ENGLISH SAVE (§4, §5 of
 * `everlore-docs/phases/reply-language.md`): the hidden English copy is made
 * after the stream closes, and everything after it reads English.
 *
 * Pure: the model call is injected, no network, no DB. The frozen English
 * outputs were captured from the INLINE code in `generation.processor.ts`
 * before this change, by copying its exact expressions (the primitives are
 * untouched). `readPlayerTurn` must reproduce them byte for byte.
 *
 *   bun --no-env-file run scripts/witness-turn-audit.ts
 *   bun --no-env-file run scripts/witness-turn-audit.ts --bites
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { env } from '../src/config/env'
import { AI_MODELS } from '../src/ai/models'
import { witnessOf } from '../src/utils/witness'
import { filterChoicePairs } from '../worker/lib/metadata-extractor'
import { auditChoicePairs } from '../worker/lib/choice-grounding-audit'
import { CONTINUE_USER_MESSAGE, offeredChipEnglish, readPlayerTurn } from '../worker/lib/player-turn'
import {
  replayWitnessFields,
  runTurnWitness,
  witnessEventFields,
} from '../worker/lib/turn-witness'
import { decideTravelIntent } from '../worker/lib/travel-intent'

// ── frozen English outputs from the unmodified code ─────────────────────────
type WorldAction = { kind: 'travel'; destination: string; companions: string[] } | { kind: 'relationship'; character: string; relation: string; correction: boolean }
interface Fixture {
  text: string
  isContinuation: boolean
  worldAction?: WorldAction | null
  cursor: string | null
  expected: {
    raw: string
    spoken: string
    narrationFacts: string[]
    explicit: string | null
    travel: string
    travelLabel: string | null
    stated: string | null
    transition: boolean
    fresh: boolean
    prompt: string
    mapKind: string
    mapDestination: string | null
    mapLabel: string | null
    mapDirective: string | null
  }
}
const FROZEN: Fixture[] = [{"text":"*I take his hand.*","isContinuation":false,"cursor":"the inn","expected":{"raw":"*I take his hand.*","spoken":"","narrationFacts":["I take his hand."],"explicit":null,"travel":"none","travelLabel":null,"stated":null,"transition":false,"fresh":false,"prompt":"[No spoken dialogue from player this turn.]","mapKind":"none","mapDestination":null,"mapLabel":null,"mapDirective":null}},{"text":"I take his hand.","isContinuation":false,"cursor":"the inn","expected":{"raw":"I take his hand.","spoken":"I take his hand.","narrationFacts":[],"explicit":null,"travel":"none","travelLabel":null,"stated":null,"transition":false,"fresh":false,"prompt":"I take his hand.","mapKind":"none","mapDestination":null,"mapLabel":null,"mapDirective":null}},{"text":"*I nod, saying nothing.*","isContinuation":false,"cursor":"the inn","expected":{"raw":"*I nod, saying nothing.*","spoken":"","narrationFacts":["I nod, saying nothing."],"explicit":null,"travel":"none","travelLabel":null,"stated":null,"transition":false,"fresh":false,"prompt":"[No spoken dialogue from player this turn.]","mapKind":"none","mapDestination":null,"mapLabel":null,"mapDirective":null}},{"text":"Hello there.","isContinuation":false,"cursor":"the inn","expected":{"raw":"Hello there.","spoken":"Hello there.","narrationFacts":[],"explicit":null,"travel":"none","travelLabel":null,"stated":null,"transition":false,"fresh":false,"prompt":"Hello there.","mapKind":"none","mapDestination":null,"mapLabel":null,"mapDirective":null}},{"text":"*I smile at her.* She smiles back.","isContinuation":false,"cursor":"the inn","expected":{"raw":"*I smile at her.* She smiles back.","spoken":"She smiles back.","narrationFacts":["I smile at her."],"explicit":null,"travel":"none","travelLabel":null,"stated":"at her","transition":false,"fresh":false,"prompt":"[PLAYER POSITION: The player has placed themselves \"at her\". That is where this scene happens. Narrate from there. Do not return them to the previous place, and do not contradict their own statement of where they are.]","mapKind":"none","mapDestination":null,"mapLabel":null,"mapDirective":null}},{"text":"*I go to the market.*","isContinuation":false,"cursor":"the inn","expected":{"raw":"*I go to the market.*","spoken":"","narrationFacts":["I go to the market."],"explicit":"the market","travel":"arrival","travelLabel":"the market","stated":"to the market","transition":true,"fresh":true,"prompt":"[PLAYER MOVEMENT COMMITMENT: The player has explicitly chosen to go to the market. Narrate the route and arrival at that exact destination. Do not redirect them to another place, substitute a different destination, or leave the journey unresolved.]\nPLAYER ACTION: *I go to the market.*","mapKind":"arrival","mapDestination":"the market","mapLabel":"the market","mapDirective":"[PLAYER MOVEMENT COMMITMENT: The player has explicitly chosen to go to the market. Narrate the route and arrival at that exact destination. Do not redirect them to another place, substitute a different destination, or leave the journey unresolved.]\nPLAYER ACTION: *I go to the market.*"}},{"text":"I walk to the market.","isContinuation":false,"cursor":"the inn","expected":{"raw":"I walk to the market.","spoken":"I walk to the market.","narrationFacts":[],"explicit":"the market","travel":"arrival","travelLabel":"the market","stated":"to the market","transition":true,"fresh":true,"prompt":"[PLAYER MOVEMENT COMMITMENT: The player has explicitly chosen to go to the market. Narrate the route and arrival at that exact destination. Do not redirect them to another place, substitute a different destination, or leave the journey unresolved.]\nPLAYER ACTION: I walk to the market.","mapKind":"arrival","mapDestination":"the market","mapLabel":"the market","mapDirective":"[PLAYER MOVEMENT COMMITMENT: The player has explicitly chosen to go to the market. Narrate the route and arrival at that exact destination. Do not redirect them to another place, substitute a different destination, or leave the journey unresolved.]\nPLAYER ACTION: I walk to the market."}},{"text":"*We return to the inn.*","isContinuation":false,"cursor":"the inn","expected":{"raw":"*We return to the inn.*","spoken":"","narrationFacts":["We return to the inn."],"explicit":null,"travel":"arrival","travelLabel":"the inn","stated":"to the inn","transition":true,"fresh":true,"prompt":"[PLAYER MOVEMENT COMMITMENT: The player has explicitly chosen to go to the inn. Narrate the route and arrival at that exact destination. Do not redirect them to another place, substitute a different destination, or leave the journey unresolved.]\nPLAYER ACTION: *We return to the inn.*","mapKind":"none","mapDestination":null,"mapLabel":"the inn","mapDirective":null}},{"text":"Let's head to the market.","isContinuation":false,"cursor":"the inn","expected":{"raw":"Let's head to the market.","spoken":"Let's head to the market.","narrationFacts":[],"explicit":"the market","travel":"intent","travelLabel":"the market","stated":null,"transition":false,"fresh":false,"prompt":"[PLAYER TRAVEL INTENT: The player intends to go to the market but has not arrived. They are still at the inn. Narrate only what happens here, or the start of a journey. Do not arrive this turn. Do not bring people from the market into this scene — they stay there until the player arrives.]\nPLAYER ACTION: Let's head to the market.","mapKind":"intent","mapDestination":"the market","mapLabel":"the market","mapDirective":"[PLAYER TRAVEL INTENT: The player intends to go to the market but has not arrived. They are still at the inn. Narrate only what happens here, or the start of a journey. Do not arrive this turn. Do not bring people from the market into this scene — they stay there until the player arrives.]\nPLAYER ACTION: Let's head to the market."}},{"text":"Let's go to the tavern.","isContinuation":false,"cursor":"the inn","expected":{"raw":"Let's go to the tavern.","spoken":"Let's go to the tavern.","narrationFacts":[],"explicit":"the tavern","travel":"intent","travelLabel":"the tavern","stated":null,"transition":false,"fresh":false,"prompt":"[PLAYER TRAVEL INTENT: The player intends to go to the tavern but has not arrived. They are still at the inn. Narrate only what happens here, or the start of a journey. Do not arrive this turn. Do not bring people from the tavern into this scene — they stay there until the player arrives.]\nPLAYER ACTION: Let's go to the tavern.","mapKind":"none","mapDestination":null,"mapLabel":"the tavern","mapDirective":null}},{"text":"I head to the tavern.","isContinuation":false,"cursor":"the inn","expected":{"raw":"I head to the tavern.","spoken":"I head to the tavern.","narrationFacts":[],"explicit":"the tavern","travel":"arrival","travelLabel":"the tavern","stated":"to the tavern","transition":true,"fresh":true,"prompt":"[PLAYER MOVEMENT COMMITMENT: The player has explicitly chosen to go to the tavern. Narrate the route and arrival at that exact destination. Do not redirect them to another place, substitute a different destination, or leave the journey unresolved.]\nPLAYER ACTION: I head to the tavern.","mapKind":"none","mapDestination":null,"mapLabel":"the tavern","mapDirective":null}},{"text":"*I leave for my room.*","isContinuation":false,"cursor":"the inn","expected":{"raw":"*I leave for my room.*","spoken":"","narrationFacts":["I leave for my room."],"explicit":null,"travel":"owned_leave","travelLabel":"my room","stated":null,"transition":true,"fresh":true,"prompt":"[PLAYER SCENE TRANSITION: The player is leaving for Nell's room. Follow their viewpoint there. Do not keep the prior room's people in this scene unless the player brought them.]\nPLAYER ACTION: *I leave for my room.*","mapKind":"owned_leave","mapDestination":"Nell's room","mapLabel":"my room","mapDirective":"[PLAYER SCENE TRANSITION: The player is leaving for Nell's room. Follow their viewpoint there. Do not keep the prior room's people in this scene unless the player brought them.]\nPLAYER ACTION: *I leave for my room.*"}},{"text":"*I walk out of the hall.*","isContinuation":false,"cursor":"the inn","expected":{"raw":"*I walk out of the hall.*","spoken":"","narrationFacts":["I walk out of the hall."],"explicit":null,"travel":"none","travelLabel":null,"stated":null,"transition":true,"fresh":true,"prompt":"[PLAYER SCENE TRANSITION: The player has physically left the prior scene. Keep the narration anchored to the player's viewpoint and the place they reach. Do NOT cut away to, or keep scene focus on, people they left behind unless the player explicitly brought them along.]\nPLAYER ACTION: *I walk out of the hall.*","mapKind":"none","mapDestination":null,"mapLabel":null,"mapDirective":null}},{"text":"I step outside.","isContinuation":false,"cursor":"the inn","expected":{"raw":"I step outside.","spoken":"I step outside.","narrationFacts":[],"explicit":null,"travel":"none","travelLabel":null,"stated":null,"transition":false,"fresh":false,"prompt":"I step outside.","mapKind":"none","mapDestination":null,"mapLabel":null,"mapDirective":null}},{"text":"I go back inside.","isContinuation":false,"cursor":"the inn","expected":{"raw":"I go back inside.","spoken":"I go back inside.","narrationFacts":[],"explicit":null,"travel":"none","travelLabel":null,"stated":null,"transition":false,"fresh":false,"prompt":"I go back inside.","mapKind":"none","mapDestination":null,"mapLabel":null,"mapDirective":null}},{"text":"*I step into the market.*","isContinuation":false,"cursor":"the inn","expected":{"raw":"*I step into the market.*","spoken":"","narrationFacts":["I step into the market."],"explicit":"the market","travel":"arrival","travelLabel":"the market","stated":"into the market","transition":true,"fresh":true,"prompt":"[PLAYER MOVEMENT COMMITMENT: The player has explicitly chosen to go to the market. Narrate the route and arrival at that exact destination. Do not redirect them to another place, substitute a different destination, or leave the journey unresolved.]\nPLAYER ACTION: *I step into the market.*","mapKind":"arrival","mapDestination":"the market","mapLabel":"the market","mapDirective":"[PLAYER MOVEMENT COMMITMENT: The player has explicitly chosen to go to the market. Narrate the route and arrival at that exact destination. Do not redirect them to another place, substitute a different destination, or leave the journey unresolved.]\nPLAYER ACTION: *I step into the market.*"}},{"text":"Where is the market?","isContinuation":false,"cursor":"the inn","expected":{"raw":"Where is the market?","spoken":"Where is the market?","narrationFacts":[],"explicit":null,"travel":"none","travelLabel":null,"stated":null,"transition":false,"fresh":false,"prompt":"Where is the market?","mapKind":"none","mapDestination":null,"mapLabel":null,"mapDirective":null}},{"text":"I am standing by the window.","isContinuation":false,"cursor":"the inn","expected":{"raw":"I am standing by the window.","spoken":"I am standing by the window.","narrationFacts":[],"explicit":null,"travel":"none","travelLabel":null,"stated":"by the window","transition":false,"fresh":false,"prompt":"[PLAYER POSITION: The player has placed themselves \"by the window\". That is where this scene happens. Narrate from there. Do not return them to the previous place, and do not contradict their own statement of where they are.]","mapKind":"none","mapDestination":null,"mapLabel":null,"mapDirective":null}},{"text":"I sit at the back table.","isContinuation":false,"cursor":"the inn","expected":{"raw":"I sit at the back table.","spoken":"I sit at the back table.","narrationFacts":[],"explicit":null,"travel":"none","travelLabel":null,"stated":"at the back table","transition":false,"fresh":false,"prompt":"[PLAYER POSITION: The player has placed themselves \"at the back table\". That is where this scene happens. Narrate from there. Do not return them to the previous place, and do not contradict their own statement of where they are.]","mapKind":"none","mapDestination":null,"mapLabel":null,"mapDirective":null}},{"text":"*I kneel beside him.*","isContinuation":false,"cursor":"the inn","expected":{"raw":"*I kneel beside him.*","spoken":"","narrationFacts":["I kneel beside him."],"explicit":null,"travel":"none","travelLabel":null,"stated":null,"transition":false,"fresh":false,"prompt":"[No spoken dialogue from player this turn.]","mapKind":"none","mapDestination":null,"mapLabel":null,"mapDirective":null}},{"text":"*I stand up and cross the room.*","isContinuation":false,"cursor":"the inn","expected":{"raw":"*I stand up and cross the room.*","spoken":"","narrationFacts":["I stand up and cross the room."],"explicit":null,"travel":"none","travelLabel":null,"stated":null,"transition":false,"fresh":false,"prompt":"[No spoken dialogue from player this turn.]","mapKind":"none","mapDestination":null,"mapLabel":null,"mapDirective":null}},{"text":"Mara, what happened?","isContinuation":false,"cursor":"the inn","expected":{"raw":"Mara, what happened?","spoken":"Mara, what happened?","narrationFacts":[],"explicit":null,"travel":"none","travelLabel":null,"stated":null,"transition":false,"fresh":false,"prompt":"Mara, what happened?","mapKind":"none","mapDestination":null,"mapLabel":null,"mapDirective":null}},{"text":"\"What is this place?\" I ask.","isContinuation":false,"cursor":"the inn","expected":{"raw":"\"What is this place?\" I ask.","spoken":"\"What is this place?\" I ask.","narrationFacts":[],"explicit":null,"travel":"none","travelLabel":null,"stated":null,"transition":false,"fresh":false,"prompt":"\"What is this place?\" I ask.","mapKind":"none","mapDestination":null,"mapLabel":null,"mapDirective":null}},{"text":"*I draw my blade.*","isContinuation":false,"cursor":"the inn","expected":{"raw":"*I draw my blade.*","spoken":"","narrationFacts":["I draw my blade."],"explicit":null,"travel":"none","travelLabel":null,"stated":null,"transition":false,"fresh":false,"prompt":"[No spoken dialogue from player this turn.]","mapKind":"none","mapDestination":null,"mapLabel":null,"mapDirective":null}},{"text":"*I sheathe my blade and sit down.*","isContinuation":false,"cursor":"the inn","expected":{"raw":"*I sheathe my blade and sit down.*","spoken":"","narrationFacts":["I sheathe my blade and sit down."],"explicit":null,"travel":"none","travelLabel":null,"stated":null,"transition":false,"fresh":false,"prompt":"[No spoken dialogue from player this turn.]","mapKind":"none","mapDestination":null,"mapLabel":null,"mapDirective":null}},{"text":"I wait by the door.","isContinuation":false,"cursor":"the inn","expected":{"raw":"I wait by the door.","spoken":"I wait by the door.","narrationFacts":[],"explicit":null,"travel":"none","travelLabel":null,"stated":"by the door","transition":false,"fresh":false,"prompt":"[PLAYER POSITION: The player has placed themselves \"by the door\". That is where this scene happens. Narrate from there. Do not return them to the previous place, and do not contradict their own statement of where they are.]","mapKind":"none","mapDestination":null,"mapLabel":null,"mapDirective":null}},{"text":"*I take the long road to the market.*","isContinuation":false,"cursor":"the inn","expected":{"raw":"*I take the long road to the market.*","spoken":"","narrationFacts":["I take the long road to the market."],"explicit":null,"travel":"none","travelLabel":null,"stated":"to the market","transition":false,"fresh":false,"prompt":"[PLAYER POSITION: The player has placed themselves \"to the market\". That is where this scene happens. Narrate from there. Do not return them to the previous place, and do not contradict their own statement of where they are.]","mapKind":"none","mapDestination":null,"mapLabel":null,"mapDirective":null}},{"text":"I follow Mara toward the market.","isContinuation":false,"cursor":"the inn","expected":{"raw":"I follow Mara toward the market.","spoken":"I follow Mara toward the market.","narrationFacts":[],"explicit":null,"travel":"arrival","travelLabel":"the market","stated":"toward the market","transition":true,"fresh":true,"prompt":"[PLAYER MOVEMENT COMMITMENT: The player has explicitly chosen to go to the market. Narrate the route and arrival at that exact destination. Do not redirect them to another place, substitute a different destination, or leave the journey unresolved.]\nPLAYER ACTION: I follow Mara toward the market.","mapKind":"arrival","mapDestination":"the market","mapLabel":"the market","mapDirective":"[PLAYER MOVEMENT COMMITMENT: The player has explicitly chosen to go to the market. Narrate the route and arrival at that exact destination. Do not redirect them to another place, substitute a different destination, or leave the journey unresolved.]\nPLAYER ACTION: I follow Mara toward the market."}},{"text":"I stop at the inn.","isContinuation":false,"cursor":"the inn","expected":{"raw":"I stop at the inn.","spoken":"I stop at the inn.","narrationFacts":[],"explicit":null,"travel":"arrival","travelLabel":"the inn","stated":"at the inn","transition":true,"fresh":true,"prompt":"[PLAYER MOVEMENT COMMITMENT: The player has explicitly chosen to go to the inn. Narrate the route and arrival at that exact destination. Do not redirect them to another place, substitute a different destination, or leave the journey unresolved.]\nPLAYER ACTION: I stop at the inn.","mapKind":"none","mapDestination":null,"mapLabel":"the inn","mapDirective":null}},{"text":"I get a room at the inn.","isContinuation":false,"cursor":"the inn","expected":{"raw":"I get a room at the inn.","spoken":"I get a room at the inn.","narrationFacts":[],"explicit":"inn","travel":"intent","travelLabel":"inn","stated":"at the inn","transition":false,"fresh":false,"prompt":"[PLAYER TRAVEL INTENT: The player intends to go to inn but has not arrived. They are still at the inn. Narrate only what happens here, or the start of a journey. Do not arrive this turn. Do not bring people from inn into this scene — they stay there until the player arrives.]\nPLAYER ACTION: I get a room at the inn.","mapKind":"none","mapDestination":null,"mapLabel":"inn","mapDirective":null}},{"text":"*I climb the stairs.*","isContinuation":false,"cursor":"the inn","expected":{"raw":"*I climb the stairs.*","spoken":"","narrationFacts":["I climb the stairs."],"explicit":null,"travel":"none","travelLabel":null,"stated":null,"transition":false,"fresh":false,"prompt":"[No spoken dialogue from player this turn.]","mapKind":"none","mapDestination":null,"mapLabel":null,"mapDirective":null}},{"text":"I reach the market at dusk.","isContinuation":false,"cursor":"the inn","expected":{"raw":"I reach the market at dusk.","spoken":"I reach the market at dusk.","narrationFacts":[],"explicit":"the market at dusk","travel":"arrival","travelLabel":"the market at dusk","stated":null,"transition":true,"fresh":true,"prompt":"[PLAYER MOVEMENT COMMITMENT: The player has explicitly chosen to go to the market at dusk. Narrate the route and arrival at that exact destination. Do not redirect them to another place, substitute a different destination, or leave the journey unresolved.]\nPLAYER ACTION: I reach the market at dusk.","mapKind":"arrival","mapDestination":"the market at dusk","mapLabel":"the market at dusk","mapDirective":"[PLAYER MOVEMENT COMMITMENT: The player has explicitly chosen to go to the market at dusk. Narrate the route and arrival at that exact destination. Do not redirect them to another place, substitute a different destination, or leave the journey unresolved.]\nPLAYER ACTION: I reach the market at dusk."}},{"text":"*I ride on.*","isContinuation":false,"cursor":"the inn","expected":{"raw":"*I ride on.*","spoken":"","narrationFacts":["I ride on."],"explicit":null,"travel":"none","travelLabel":null,"stated":null,"transition":false,"fresh":false,"prompt":"[No spoken dialogue from player this turn.]","mapKind":"none","mapDestination":null,"mapLabel":null,"mapDirective":null}},{"text":"I look for the tavern where Mara works.","isContinuation":false,"cursor":"the inn","expected":{"raw":"I look for the tavern where Mara works.","spoken":"I look for the tavern where Mara works.","narrationFacts":[],"explicit":null,"travel":"intent","travelLabel":"where Mara works","stated":null,"transition":false,"fresh":false,"prompt":"[PLAYER TRAVEL INTENT: The player intends to go to where Mara works but has not arrived. They are still at the inn. Narrate only what happens here, or the start of a journey. Do not arrive this turn. Do not bring people from where Mara works into this scene — they stay there until the player arrives.]\nPLAYER ACTION: I look for the tavern where Mara works.","mapKind":"none","mapDestination":null,"mapLabel":"where Mara works","mapDirective":null}},{"text":"*I go to my chambers.*","isContinuation":false,"cursor":"the inn","expected":{"raw":"*I go to my chambers.*","spoken":"","narrationFacts":["I go to my chambers."],"explicit":null,"travel":"owned_leave","travelLabel":"my room","stated":"to my chambers","transition":true,"fresh":true,"prompt":"[PLAYER SCENE TRANSITION: The player is leaving for Nell's room. Follow their viewpoint there. Do not keep the prior room's people in this scene unless the player brought them.]\nPLAYER ACTION: *I go to my chambers.*","mapKind":"owned_leave","mapDestination":"Nell's room","mapLabel":"my room","mapDirective":"[PLAYER SCENE TRANSITION: The player is leaving for Nell's room. Follow their viewpoint there. Do not keep the prior room's people in this scene unless the player brought them.]\nPLAYER ACTION: *I go to my chambers.*"}},{"text":"*I leave the room.*","isContinuation":false,"cursor":"the inn","expected":{"raw":"*I leave the room.*","spoken":"","narrationFacts":["I leave the room."],"explicit":null,"travel":"none","travelLabel":null,"stated":null,"transition":true,"fresh":true,"prompt":"[PLAYER SCENE TRANSITION: The player has physically left the prior scene. Keep the narration anchored to the player's viewpoint and the place they reach. Do NOT cut away to, or keep scene focus on, people they left behind unless the player explicitly brought them along.]\nPLAYER ACTION: *I leave the room.*","mapKind":"none","mapDestination":null,"mapLabel":null,"mapDirective":null}},{"text":"I return to my room.","isContinuation":false,"cursor":"the inn","expected":{"raw":"I return to my room.","spoken":"I return to my room.","narrationFacts":[],"explicit":null,"travel":"owned_leave","travelLabel":"my room","stated":"to my room","transition":true,"fresh":true,"prompt":"[PLAYER SCENE TRANSITION: The player is leaving for Nell's room. Follow their viewpoint there. Do not keep the prior room's people in this scene unless the player brought them.]\nPLAYER ACTION: I return to my room.","mapKind":"owned_leave","mapDestination":"Nell's room","mapLabel":"my room","mapDirective":"[PLAYER SCENE TRANSITION: The player is leaving for Nell's room. Follow their viewpoint there. Do not keep the prior room's people in this scene unless the player brought them.]\nPLAYER ACTION: I return to my room."}},{"text":"*I slip out the back.*","isContinuation":false,"cursor":"the inn","expected":{"raw":"*I slip out the back.*","spoken":"","narrationFacts":["I slip out the back."],"explicit":null,"travel":"none","travelLabel":null,"stated":null,"transition":false,"fresh":false,"prompt":"[No spoken dialogue from player this turn.]","mapKind":"none","mapDestination":null,"mapLabel":null,"mapDirective":null}},{"text":"I stay where I am.","isContinuation":false,"cursor":"the inn","expected":{"raw":"I stay where I am.","spoken":"I stay where I am.","narrationFacts":[],"explicit":null,"travel":"none","travelLabel":null,"stated":null,"transition":false,"fresh":false,"prompt":"I stay where I am.","mapKind":"none","mapDestination":null,"mapLabel":null,"mapDirective":null}},{"text":"I am in the market now.","isContinuation":false,"cursor":"the inn","expected":{"raw":"I am in the market now.","spoken":"I am in the market now.","narrationFacts":[],"explicit":null,"travel":"none","travelLabel":null,"stated":"in the market now","transition":false,"fresh":false,"prompt":"[PLAYER POSITION: The player has placed themselves \"in the market now\". That is where this scene happens. Narrate from there. Do not return them to the previous place, and do not contradict their own statement of where they are.]","mapKind":"none","mapDestination":null,"mapLabel":null,"mapDirective":null}},{"text":"*I walk into the great hall.*","isContinuation":false,"cursor":"the inn","expected":{"raw":"*I walk into the great hall.*","spoken":"","narrationFacts":["I walk into the great hall."],"explicit":"the great hall","travel":"arrival","travelLabel":"the great hall","stated":"into the great hall","transition":true,"fresh":true,"prompt":"[PLAYER MOVEMENT COMMITMENT: The player has explicitly chosen to go to the great hall. Narrate the route and arrival at that exact destination. Do not redirect them to another place, substitute a different destination, or leave the journey unresolved.]\nPLAYER ACTION: *I walk into the great hall.*","mapKind":"arrival","mapDestination":"the great hall","mapLabel":"the great hall","mapDirective":"[PLAYER MOVEMENT COMMITMENT: The player has explicitly chosen to go to the great hall. Narrate the route and arrival at that exact destination. Do not redirect them to another place, substitute a different destination, or leave the journey unresolved.]\nPLAYER ACTION: *I walk into the great hall.*"}},{"text":"I enter the tavern.","isContinuation":false,"cursor":"the inn","expected":{"raw":"I enter the tavern.","spoken":"I enter the tavern.","narrationFacts":[],"explicit":null,"travel":"arrival","travelLabel":"the tavern","stated":null,"transition":true,"fresh":true,"prompt":"[PLAYER MOVEMENT COMMITMENT: The player has explicitly chosen to go to the tavern. Narrate the route and arrival at that exact destination. Do not redirect them to another place, substitute a different destination, or leave the journey unresolved.]\nPLAYER ACTION: I enter the tavern.","mapKind":"none","mapDestination":null,"mapLabel":"the tavern","mapDirective":null}},{"text":"*I go outside to think.*","isContinuation":false,"cursor":"the inn","expected":{"raw":"*I go outside to think.*","spoken":"","narrationFacts":["I go outside to think."],"explicit":null,"travel":"none","travelLabel":null,"stated":null,"transition":false,"fresh":false,"prompt":"[No spoken dialogue from player this turn.]","mapKind":"none","mapDestination":null,"mapLabel":null,"mapDirective":null}},{"text":"I cross to the window.","isContinuation":false,"cursor":"the inn","expected":{"raw":"I cross to the window.","spoken":"I cross to the window.","narrationFacts":[],"explicit":null,"travel":"none","travelLabel":null,"stated":"to the window","transition":false,"fresh":false,"prompt":"[PLAYER POSITION: The player has placed themselves \"to the window\". That is where this scene happens. Narrate from there. Do not return them to the previous place, and do not contradict their own statement of where they are.]","mapKind":"none","mapDestination":null,"mapLabel":null,"mapDirective":null}},{"text":"I turn away.","isContinuation":false,"cursor":"the inn","expected":{"raw":"I turn away.","spoken":"I turn away.","narrationFacts":[],"explicit":null,"travel":"none","travelLabel":null,"stated":null,"transition":false,"fresh":false,"prompt":"I turn away.","mapKind":"none","mapDestination":null,"mapLabel":null,"mapDirective":null}},{"text":"*I say nothing.*","isContinuation":false,"cursor":"the inn","expected":{"raw":"*I say nothing.*","spoken":"","narrationFacts":[],"explicit":null,"travel":"none","travelLabel":null,"stated":null,"transition":false,"fresh":false,"prompt":"[No spoken dialogue from player this turn.]","mapKind":"none","mapDestination":null,"mapLabel":null,"mapDirective":null}},{"text":"Nothing.","isContinuation":false,"cursor":"the inn","expected":{"raw":"Nothing.","spoken":"Nothing.","narrationFacts":[],"explicit":null,"travel":"none","travelLabel":null,"stated":null,"transition":false,"fresh":false,"prompt":"Nothing.","mapKind":"none","mapDestination":null,"mapLabel":null,"mapDirective":null}},{"text":"","isContinuation":true,"cursor":"the inn","expected":{"raw":"","spoken":"","narrationFacts":[],"explicit":null,"travel":"none","travelLabel":null,"stated":null,"transition":false,"fresh":false,"prompt":"[The player waits and observes. Continue the current beat naturally without asking what they do. You MUST move the scene through a concrete response: a present NPC speaks (preferred in a conversation), takes a meaningful action, makes a decision, reveals information, or produces a consequence. Do NOT answer a Continue with only silence, tension, glances, hesitation, body language, or atmospheric description; never repeat a stalled silence from the preceding beat. A detached or disinterested character still responds through a terse dismissal, evasion, refusal, cold action, or consequential withdrawal. Do not introduce a new complication, location, character, danger, romance escalation, or major plot turn unless it was already clearly set up by recent events. Because this is an autonomous continuation, do not open with the active character's name; begin with pronoun, action, body language, speech, or setting instead.]","mapKind":"none","mapDestination":null,"mapLabel":null,"mapDirective":null}},{"text":"","isContinuation":false,"cursor":"the inn","worldAction":{"kind":"travel","destination":"the market","companions":["Mara"]},"expected":{"raw":"*I travel to the market with Mara.*","spoken":"","narrationFacts":["I travel to the market with Mara."],"explicit":null,"travel":"none","travelLabel":null,"stated":null,"transition":true,"fresh":true,"prompt":"[PLAYER MOVEMENT COMMITMENT: The player has explicitly chosen to go to the market with Mara. Narrate the route and arrival at that exact destination. Do not redirect them to another place, substitute a different destination, or leave the journey unresolved.]\nPLAYER ACTION: *I travel to the market with Mara.*","mapKind":"arrival","mapDestination":"the market with Mara","mapLabel":"the market with Mara","mapDirective":"[PLAYER MOVEMENT COMMITMENT: The player has explicitly chosen to go to the market with Mara. Narrate the route and arrival at that exact destination. Do not redirect them to another place, substitute a different destination, or leave the journey unresolved.]\nPLAYER ACTION: *I travel to the market with Mara.*"}},{"text":"","isContinuation":false,"cursor":"the inn","worldAction":{"kind":"relationship","character":"Mara","relation":"sister","correction":false},"expected":{"raw":"*Mara is my sister.*","spoken":"","narrationFacts":["Mara is my sister."],"explicit":null,"travel":"none","travelLabel":null,"stated":null,"transition":false,"fresh":false,"prompt":"[PLAYER WORLD ACTION — RELATIONSHIP: The player confirmed that Mara is their sister. Treat this as established canon. Acknowledge it naturally; do not question or reinterpret the relationship.]","mapKind":"none","mapDestination":null,"mapLabel":null,"mapDirective":null}}]

const PLACES = [
  { name: 'the market', aliases: ['marketplace'] },
  { name: 'the inn', aliases: ['the tavern'] },
  { name: "Nell's room", aliases: [] },
]
const PEOPLE = [{ name: 'Mara', aliases: ['the steward'], placeName: 'the market' }]
const worldActionNarration = (action?: WorldAction | null) =>
  !action ? '' : action.kind === 'travel'
    ? `*I travel to ${action.destination}${action.companions.length ? ` with ${action.companions.join(', ')}` : ' alone'}.*`
    : `*${action.correction ? 'Actually, ' : ''}${action.character} is my ${action.relation}.*`
const worldActionDirective = (action: WorldAction) => action.kind === 'travel'
  ? `[PLAYER WORLD ACTION — TRAVEL: The player has already committed to travelling to ${action.destination} with ${action.companions.join(', ') || 'the player alone'}. Narrate the journey and arrival grounded in established canon. Do not redirect, veto, or reinterpret the destination or travelling party.]`
  : `[PLAYER WORLD ACTION — RELATIONSHIP: The player ${action.correction ? 'corrected' : 'confirmed'} that ${action.character} is their ${action.relation}. Treat this as established canon. Acknowledge it naturally; do not question or reinterpret the relationship.]`

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

function freezeTurn(text: string, cursor: string | null, isContinuation: boolean, worldAction?: WorldAction | null) {
  const actionNarration = worldActionNarration(worldAction)
  const reading = isContinuation ? '' : actionNarration || text
  const travel = decideTravelIntent({
    playerInput: reading,
    isContinuation,
    cursorName: cursor,
    cursorEntityId: null,
    knownPlaces: PLACES,
    personPlaces: PEOPLE,
    pending: null,
    playerName: 'Nell',
  })
  const turn = readPlayerTurn({
    playerText: text,
    isContinuation,
    worldAction: worldAction ?? undefined,
    actionNarration,
    worldActionDirective: worldAction ? worldActionDirective(worldAction) : undefined,
    priorPending: null,
    cursorName: cursor,
    travelCursorName: cursor,
    travel,
  })
  return { turn, travel }
}

// ── 1. the helper reproduces the inline English turn, byte for byte ─────────
await check('readPlayerTurn: every frozen English turn matches, prompt bytes included', () => {
  assert.ok(FROZEN.length >= 40, `at least 40 frozen turns (found ${FROZEN.length})`)
  const kinds = new Set(FROZEN.map((f) => f.expected.travel))
  for (const kind of ['arrival', 'owned_leave', 'intent', 'none']) {
    assert.ok(kinds.has(kind), `the fixtures must cover the ${kind} reading`)
  }
  assert.ok(FROZEN.some((f) => f.isContinuation), 'the fixtures must cover a continue')
  assert.ok(FROZEN.some((f) => f.worldAction), 'the fixtures must cover a world action')
  assert.ok(FROZEN.some((f) => f.expected.stated), 'the fixtures must cover a stated position')
  for (const fixture of FROZEN) {
    const { turn, travel } = freezeTurn(fixture.text, fixture.cursor, fixture.isContinuation, fixture.worldAction)
    const actual = {
      raw: turn.parsed.raw,
      spoken: turn.parsed.spoken,
      narrationFacts: turn.parsed.narrationFacts,
      explicit: turn.explicitPhysicalDestination,
      travel: turn.playerTravel.kind,
      travelLabel: turn.playerTravel.label,
      stated: turn.statedPosition,
      transition: turn.playerSceneTransition,
      fresh: turn.playerForcesFreshCast,
      prompt: turn.promptUserMessage,
      mapKind: travel.kind,
      mapDestination: travel.destination?.name ?? null,
      mapLabel: travel.label,
      mapDirective: turn.mapTravelDirective,
    }
    if (JSON.stringify(actual) !== JSON.stringify(fixture.expected)) {
      assert.fail(`frozen turn changed for ${JSON.stringify(fixture.text)}:\n  expected ${JSON.stringify(fixture.expected)}\n  actual   ${JSON.stringify(actual)}`)
    }
  }
})

await check('readPlayerTurn: the narrator words stay native when the reading is English', () => {
  const english = readPlayerTurn({
    playerText: 'I go to the market.',
    narratorText: 'Eu vou ao mercado.',
    isContinuation: false,
    priorPending: null,
    cursorName: 'the inn',
  })
  assert.equal(english.parsed.raw, 'I go to the market.')
  assert.equal(english.narratorParsed.raw, 'Eu vou ao mercado.')
  assert.ok(english.promptUserMessage.includes('Eu vou ao mercado.'), 'the prompt must show the player\'s own words')
})

await check('readPlayerTurn: the continue directive is the processor\'s own string', () => {
  assert.ok(CONTINUE_USER_MESSAGE.startsWith('[The player waits and observes.'))
  assert.ok(CONTINUE_USER_MESSAGE.endsWith('begin with pronoun, action, body language, speech, or setting instead.]'))
  const turn = readPlayerTurn({ playerText: '', isContinuation: true, cursorName: null })
  assert.equal(turn.promptUserMessage, CONTINUE_USER_MESSAGE)
})

// ── 2. a tapped chip's stored English is the player's English ───────────────
await check('tapped chip: the stored English moves the player, an altered chip does not', () => {
  const event = {
    data: {
      choices: [
        { label: 'Ir ao mercado', kind: 'act', send: 'Ir ao mercado' },
        { label: 'Ficar', kind: 'act', send: '*Fico parado.*' },
      ],
      witness: { lang: 'pt', choices: [{ label: 'Go to the market', send: 'I go to the market.' }, { label: 'Stay', send: '*I stay still.*' }] },
    },
  }
  const english = offeredChipEnglish('Ir ao mercado', event)
  assert.equal(english, 'I go to the market.', 'the chip\'s stored send is the player English')
  // The normalisation ignores case, spacing and punctuation.
  assert.equal(offeredChipEnglish('  ir   ao MERCADO! ', event), 'I go to the market.')
  // An altered chip is not the chip: no stored English, no move.
  assert.equal(offeredChipEnglish('Ir para o mercado', event), undefined)
  // No stored English at all (an English turn) means no chip English.
  assert.equal(offeredChipEnglish('Ir ao mercado', { data: { choices: event.data.choices } }), undefined)
  // The reading follows the English: it is an arrival; the native line is not.
  const { turn: moved } = freezeTurn(english!, 'the inn', false)
  assert.equal(moved.parsed.raw, 'I go to the market.')
  const { turn: altered } = freezeTurn('Ir para o mercado', 'the inn', false)
  assert.equal(moved.playerTravel.kind, 'arrival')
  assert.equal(altered.playerTravel.kind, 'none')
})

// ── 3. the turn-witness decision ────────────────────────────────────────────
const NATIVE_PROSE = 'Mara entra no salão e pendura o casaco molhado. "Você demorou", ela diz.'
const ENGLISH_PROSE = 'Mara enters the hall and hangs up her wet coat. "You took your time", she says.'
const NATIVE_PLAYER = '*Eu me encosto no batente, observando-a.* Quanto tempo você ficou fora?'
const ENGLISH_PLAYER = '*I lean against the doorframe, watching her.* How long were you away?'
const LANGUAGE = { code: 'pt', name: 'Brazilian Portuguese' }
const WITNESS_BASE = {
  language: LANGUAGE,
  playerNative: NATIVE_PLAYER,
  proseNative: NATIVE_PROSE,
  people: ['Mara', 'Nell'],
  places: ['the hall'],
  pov: 'third' as const,
  playerName: 'Nell',
  protagonistName: 'Nell',
  isSentient: true,
}
const copied = { content: JSON.stringify({ player: ENGLISH_PLAYER, prose: ENGLISH_PROSE }), finishReason: 'stop' }

function clock() {
  let t = 0
  return () => (t += 5)
}

await check('witness: an accepted copy returns the English player and prose, with ms and attempts', async () => {
  let request: Record<string, any> | undefined
  const outcome = await runTurnWitness(WITNESS_BASE, {
    primaryModel: 'audit-primary',
    retryModel: 'audit-retry',
    now: clock(),
    call: async (req) => {
      request = req as any
      return copied
    },
  })
  assert.equal(outcome.status, 'accepted')
  assert.equal(outcome.status === 'accepted' && outcome.player, ENGLISH_PLAYER)
  assert.equal(outcome.status === 'accepted' && outcome.prose, ENGLISH_PROSE)
  assert.equal(outcome.status === 'accepted' && outcome.attempts, 1)
  assert.equal(outcome.status === 'accepted' && outcome.ms, 5)
  assert.equal(request?.model, 'audit-primary')
  assert.equal(request?.temperature, 0)
})

await check('witness: a refused copy is rejected with its reason and attempts, never thrown', async () => {
  const outcome = await runTurnWitness(WITNESS_BASE, {
    primaryModel: 'p',
    retryModel: 'r',
    now: clock(),
    call: async () => ({ content: JSON.stringify({ player: ENGLISH_PLAYER, prose: ENGLISH_PROSE }), finishReason: 'length' }),
  })
  assert.equal(outcome.status, 'rejected')
  assert.equal(outcome.status === 'rejected' && outcome.reason, 'finish')
  assert.equal(outcome.status === 'rejected' && outcome.attempts, 2)
})

await check('witness: an abort is rethrown and never swallowed', async () => {
  const controller = new AbortController()
  const reason = new Error('turn cancelled')
  controller.abort(reason)
  await assert.rejects(
    runTurnWitness({ ...WITNESS_BASE, signal: controller.signal }, { call: async () => copied }),
    (error) => error === reason,
  )
})

await check('witness: a continue asks for prose only and copies no player part', async () => {
  let request: Record<string, any> | undefined
  const outcome = await runTurnWitness({ ...WITNESS_BASE, playerNative: '' }, {
    now: clock(),
    call: async (req) => {
      request = req as any
      return { content: JSON.stringify({ prose: ENGLISH_PROSE }), finishReason: 'stop' }
    },
  })
  assert.equal(outcome.status, 'accepted')
  assert.equal(outcome.status === 'accepted' && outcome.player, '')
  assert.deepEqual((request?.responseSchema as any).required, ['prose'])
  assert.equal(String(request?.messages?.[1]?.content).includes('<player>'), false)
})

await check('witness: a world action copies the prose only', async () => {
  let request: Record<string, any> | undefined
  const outcome = await runTurnWitness({ ...WITNESS_BASE, playerNative: '' }, {
    now: clock(),
    call: async (req) => {
      request = req as any
      return { content: JSON.stringify({ prose: ENGLISH_PROSE }), finishReason: 'stop' }
    },
  })
  assert.equal(outcome.status, 'accepted')
  assert.deepEqual((request?.responseSchema as any).required, ['prose'])
})

await check('witness: an English turn makes no call at all', async () => {
  let calls = 0
  const outcome = await runTurnWitness({ ...WITNESS_BASE, language: null }, {
    call: async () => {
      calls++
      return copied
    },
  })
  assert.deepEqual(outcome, { status: 'not_needed' })
  assert.equal(calls, 0)
})

// ── 4/5. event and replay-variant fields in each case ───────────────────────
await check('stored fields: all four text fields on acceptance, failure flag on refusal, nothing on English', () => {
  const choices = [{ label: 'Perguntar', send: 'Perguntar por quê' }]
  const accepted = witnessEventFields({
    language: LANGUAGE,
    accepted: { player: ENGLISH_PLAYER, prose: ENGLISH_PROSE },
    choices,
  })
  assert.ok(accepted.witness, 'an accepted turn stores a witness')
  const w = accepted.witness!
  assert.equal(w.lang, 'pt')
  assert.equal(w.ai_response, ENGLISH_PROSE)
  assert.equal(w.player_input, ENGLISH_PLAYER)
  assert.equal(typeof w.player_spoken_input, 'string')
  assert.equal(w.player_spoken_input, 'How long were you away?')
  assert.deepEqual(w.player_narration_facts, ['I lean against the doorframe, watching her.'])
  assert.deepEqual(w.choices, choices)
  assert.equal('witness_status' in accepted, false, 'the failure flag only appears on failure')

  const continuation = witnessEventFields({ language: LANGUAGE, accepted: { player: '', prose: ENGLISH_PROSE } })
  assert.equal(continuation.witness?.player_input, '')
  assert.equal(continuation.witness?.player_spoken_input, '')
  assert.deepEqual(continuation.witness?.player_narration_facts, [])
  assert.equal('choices' in (continuation.witness || {}), false, 'an empty pair set is omitted')

  assert.deepEqual(witnessEventFields({ language: LANGUAGE, accepted: null }), { witness_status: 'failed' })
  assert.deepEqual(witnessEventFields({ language: null, accepted: null }), {}, 'an English turn gains no keys')

  const variant = replayWitnessFields({ language: LANGUAGE, accepted: { player: ENGLISH_PLAYER, prose: ENGLISH_PROSE }, choices })
  assert.deepEqual(variant, {
    witness: { lang: 'pt', ai_response: ENGLISH_PROSE, player_input: ENGLISH_PLAYER, choices },
  })
  assert.deepEqual(replayWitnessFields({ language: LANGUAGE, accepted: null }), {}, 'a refused copy leaves no variant witness')
  assert.equal(witnessOf({ data: { ...accepted, ai_response: NATIVE_PROSE, player_input: NATIVE_PLAYER } }).ai_response, ENGLISH_PROSE)
})

// ── 6. pairs aligned after every filter ─────────────────────────────────────
await check('choices: every filter keeps the native chips and English pairs aligned', () => {
  const native = [
    { label: 'Abraçar meu irmão', kind: 'act' as const, send: '*Eu abraço meu irmão.*' },
    { label: 'Esperar', kind: 'act' as const, send: '*Eu espero.*' },
    { label: 'Ir ao mercado', kind: 'act' as const, send: '*Eu vou ao mercado.*' },
  ]
  const pairs = [
    { label: 'Hug my brother', send: '*I hug my brother.*' },
    { label: 'Wait', send: '*I wait.*' },
    { label: 'Go to the market', send: '*I go to the market.*' },
  ]
  const filtered = filterChoicePairs(native, pairs, (choice, english) => !/brother/i.test(`${(english ?? choice).send}`))
  assert.deepEqual(filtered.choices.map((c) => c.label), ['Esperar', 'Ir ao mercado'])
  assert.deepEqual(filtered.choices_en, [pairs[1], pairs[2]], 'the second filter must keep pairs by index')
  const audited = auditChoicePairs(filtered.choices, filtered.choices_en, ['Mara (sister)'], 'Mara stands alone beside the road.')
  assert.equal(audited.choices.length, audited.choices_en.length)
  assert.deepEqual(audited.choices_en, filtered.choices_en)
  assert.equal(audited.repairedCount, 0, 'a non-English turn drops a would-be repair instead of keeping a half-grounded chip')
  // A half-pair is dropped rather than shipped.
  const half = filterChoicePairs(native, pairs.slice(0, 1), () => true)
  assert.deepEqual(half.choices.map((c) => c.label), ['Abraçar meu irmão'])
  assert.equal(half.choices_en.length, 1)
})

// ── 7. the after-reply guard note ───────────────────────────────────────────
await check('the guard note: the English text is screened, ids only, nothing removed', () => {
  const english = 'I have sex with my sister.'
  // The processor reads the accepted witness's English player text and logs a
  // category with ids; it must not carry the text and must not gate anything.
  assert.ok(english.toLowerCase().includes('sister'))
  const source = readFileSyncSafe('worker/processors/generation.processor.ts')
  assert.match(source, /const guard = screenPlayerInput\(acceptedWitness\.player\)/)
  assert.match(source, /log\.warn\('input_guard\.after_reply', \{[^}]*category: guard\.category/)
  assert.equal(/input_guard\.after_reply', \{[^}]*player/.test(source), false, 'the guard note must not carry the player text')
})

function readFileSyncSafe(relative: string): string {
  return readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8')
}

// ── 8-10. the processor's wiring, pinned at the numbered points ─────────────
await check('processor: the witness is made after publishStreamEnd, guarded, and English turns never await it', () => {
  const source = readFileSyncSafe('worker/processors/generation.processor.ts')
  const publish = source.indexOf('publishStreamEnd(rawNarrative)')
  const witness = source.indexOf('await runTurnWitness(')
  assert.ok(publish > 0, 'the stream end is present')
  assert.ok(witness > publish, 'the witness must be made after publishStreamEnd and its await')
  assert.equal((source.match(/await runTurnWitness\(/g) || []).length, 1, 'the witness is made once')
  const guardOpen = source.indexOf('if (turnReplyLanguage) {', publish)
  assert.ok(guardOpen > publish && guardOpen < witness, 'the witness must sit inside the language guard, so an English turn never awaits')
  const helper = readFileSyncSafe('worker/lib/turn-witness.ts')
  assert.ok(helper.includes('makeWitness'), 'the decision lives in the injectable module')
  assert.ok(helper.includes('await makeWitness('), 'the module owns the call')
})

await check('processor: the post-stream half reads the native copies only where the allow list says', () => {
  const source = readFileSyncSafe('worker/processors/generation.processor.ts')
  const post = source.slice(source.indexOf('publishStreamEnd(rawNarrative)'))
  const ALLOWED = [
    'const nativeNarrative = rawNarrative',
    'narrative: nativeNarrative,',
    'const finalNarrative = nativeNarrative',
    'playerInput: nativePlayerInputRaw,',
    'proseNative: nativeNarrative,',
  ]
  const offenders: string[] = []
  for (const line of post.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
    if (!/nativeNarrative|nativePlayerInputRaw/.test(line)) continue
    if (!ALLOWED.some((allowed) => line.includes(allowed))) offenders.push(trimmed)
  }
  assert.deepEqual(offenders, [], `post-stream reads of the native copies must stay on the allow list: ${offenders.join(' | ')}`)
})

await check('processor: the choice pass reads native, the extractors read English, and pairs survive every filter', () => {
  const source = readFileSyncSafe('worker/processors/generation.processor.ts')
  assert.ok(source.includes('choiceLanguage: {'), 'the choice pass needs the native language input')
  assert.ok(source.includes('narrative: nativeNarrative,'), 'the choice pass reads the native prose')
  assert.ok(source.includes('playerInput: nativePlayerInputRaw,'), 'the choice pass reads the native player turn')
  // A tapped chip's English drives the reading, not what the choice writer is shown.
  assert.ok(source.includes("'Continue the current scene.' : nativePlayerInputRaw,"), 'the choice context reads the native player turn')
  assert.ok(source.includes('witness_copy: witnessMs,'), 'the copy is a stage in the turn timing')
  assert.ok(source.includes('? auditChoicePairs('), 'a non-English turn grounds the English pair')
  assert.ok(source.includes('filterChoicePairs('), 'the life-state filters keep pairs aligned')
  assert.ok(source.includes('parsed.choices_en = choicesEn'), 'the aligned English pairs are what the event stores')
})

await check('processor: the memory payload is English and the previous turn comes from witnessOf', () => {
  const source = readFileSyncSafe('worker/processors/generation.processor.ts')
  assert.ok(source.includes('precedingAiResponse: witnessOf(recentEvents[recentEvents.length - 1]).ai_response'))
  assert.ok(source.includes('aiResponse: rawNarrative'))
  assert.ok(source.includes('playerNarrationFacts: parsedPlayerInput.narrationFacts'))
})

await check('processor: the accepted copy drives parsedPlayerInput and the map reading', () => {
  const source = readFileSyncSafe('worker/processors/generation.processor.ts')
  assert.ok(source.includes('parsedPlayerInput = parsePlayerInput(outcome.player)'), 'the English player replaces the native reading')
  assert.ok(source.includes('travel = readTravel(parsedPlayerInput.raw)'), 'the travel decision is recomputed from the English')
  assert.ok(source.includes('const nativeNarrative = rawNarrative'), 'the streamed prose is kept native')
  assert.ok(source.includes('...witnessEventFields({'), 'the stored witness comes from the decision module')
  assert.ok(source.includes('...replayWitnessFields({'), 'the replay variant carries its own witness')
})

await check('env: MODEL_WITNESS_COPY defaults empty and the SFW narrator as before', () => {
  const models = readFileSyncSafe('src/ai/models.ts')
  assert.ok(models.includes('witnessCopy: env.MODEL_WITNESS_COPY || env.NARRATION_SFW_MODEL,'))
  assert.equal(env.MODEL_WITNESS_COPY, '')
  assert.equal(AI_MODELS.witnessCopy, env.NARRATION_SFW_MODEL)
})

if (fail > 0) {
  console.log(`\nwitness turn audit: ${pass} passed, ${fail} failed`)
  process.exit(1)
}

if (process.argv.includes('--bites')) {
  await runBites()
} else {
  console.log(`\nwitness turn audit: ${pass} passed, 0 failed`)
}

// ── bites ────────────────────────────────────────────────────────────────────
type Edit = [file: string, from: string, to: string]
type Mutation = { name: string; check: string; edits: Edit[] }

async function runBites() {
  const root = await mkdtemp(join(import.meta.dir, '.witness-turn-bites-'))
  const server = new URL('..', import.meta.url).pathname
  const AUDIT = 'scripts/witness-turn-audit.ts'
  const turn = 'worker/lib/player-turn.ts'
  const witness = 'worker/lib/turn-witness.ts'
  const processor = 'worker/processors/generation.processor.ts'
  const models = 'src/ai/models.ts'

  const mutations: Mutation[] = [
    {
      name: '1 readPlayerTurn: the position prompt wording moved',
      check: 'readPlayerTurn: every frozen English turn matches, prompt bytes included',
      edits: [[turn, 'That is where this scene happens.', 'That is where the scene happens.']],
    },
    {
      name: '2 tapped chip: the stored English is never read',
      check: 'tapped chip: the stored English moves the player, an altered chip does not',
      edits: [[turn, 'return typeof stored === \'string\' && stored.trim() ? stored : undefined', 'return undefined']],
    },
    {
      name: '3 witness: a refused copy is taken as accepted',
      check: 'witness: a refused copy is rejected with its reason and attempts, never thrown',
      edits: [[witness, '  if (result.ok) {', '  if (true) {']],
    },
    {
      name: '4 allow list: one more post-stream native read',
      check: 'processor: the post-stream half reads the native copies only where the allow list says',
      edits: [[processor, '  const nativeNarrative = rawNarrative\n', '  const nativeNarrative = rawNarrative\n  const leakedNative = nativeNarrative\n']],
    },
    {
      name: '5 stored fields: the spoken player text is dropped',
      check: 'stored fields: all four text fields on acceptance, failure flag on refusal, nothing on English',
      edits: [[witness, '      player_spoken_input: english.spoken,\n', '']],
    },
    {
      name: '6 choices: the pair audit is replaced by the repair pass',
      check: 'processor: the choice pass reads native, the extractors read English, and pairs survive every filter',
      edits: [[processor, '? auditChoicePairs(', '? auditChoices(']],
    },
    {
      name: '6b choices: the choice context is shown a tapped chip in English',
      check: 'processor: the choice pass reads native, the extractors read English, and pairs survive every filter',
      edits: [[processor, "'Continue the current scene.' : nativePlayerInputRaw,", "'Continue the current scene.' : parsedPlayerInput.raw,"]],
    },
    {
      name: '7 guard: the after-reply screen is gone',
      check: 'the guard note: the English text is screened, ids only, nothing removed',
      edits: [[processor, 'const guard = screenPlayerInput(acceptedWitness.player)', 'const guard = { blocked: false } as { blocked: boolean; category?: string }']],
    },
    {
      name: '8 memory: the previous turn reads the native field again',
      check: 'processor: the memory payload is English and the previous turn comes from witnessOf',
      edits: [[processor, 'witnessOf(recentEvents[recentEvents.length - 1]).ai_response', 'recentEvents[recentEvents.length - 1]?.data?.ai_response']],
    },
    {
      name: '9 env: the default is no longer the SFW narrator',
      check: 'env: MODEL_WITNESS_COPY defaults empty and the SFW narrator as before',
      edits: [[models, 'witnessCopy: env.MODEL_WITNESS_COPY || env.NARRATION_SFW_MODEL,', 'witnessCopy: env.MODEL_WITNESS_COPY,']],
    },
    {
      name: '10 native moves: the accepted player part is not replaced',
      check: 'processor: the accepted copy drives parsedPlayerInput and the map reading',
      edits: [[processor, '        parsedPlayerInput = parsePlayerInput(outcome.player)', '        void outcome.player']],
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
        stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
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
    console.log(`witness turn bites: ${bitten}/${mutations.length} mutations rejected; scratch restored and removed`)
    if (bitten !== mutations.length) process.exit(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
