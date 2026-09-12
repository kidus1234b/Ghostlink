/**
 * The recovery-phrase wordlist.
 *
 * One list, shared by every screen that generates or checks a phrase. It used
 * to be duplicated: SetupScreen carried 575 words and RecoveryScreen only 183,
 * so the two screens produced phrases of different strength (110 vs 90 bits).
 *
 * This is a curated subset, not the standard 2048-word BIP-39 list, and it
 * carries no BIP-39 checksum — a phrase from here is not interchangeable with
 * another wallet's. See SEED_PHRASE_BITS for what it is actually worth.
 */
export const WORDLIST = [
  'abandon', 'ability', 'able', 'above', 'absent', 'absorb', 'abuse', 'access',
  'account', 'achieve', 'acid', 'across', 'action', 'actor', 'adapt', 'address',
  'admit', 'adult', 'advance', 'advice', 'afford', 'afraid', 'again', 'agent',
  'agree', 'aim', 'airport', 'alarm', 'album', 'alert', 'alien', 'alley',
  'allow', 'almost', 'alone', 'already', 'alter', 'amateur', 'amazing', 'anchor',
  'ancient', 'anger', 'angle', 'animal', 'annual', 'antenna', 'anxiety', 'appear',
  'approve', 'arch', 'arctic', 'area', 'argue', 'armor', 'army', 'arrest',
  'arrive', 'artist', 'aspect', 'assault', 'assist', 'athlete', 'attach', 'attend',
  'attract', 'audit', 'author', 'autumn', 'aware', 'awesome', 'axis', 'balance',
  'bamboo', 'banner', 'barely', 'barrel', 'battle', 'beauty', 'become', 'benefit',
  'betray', 'bicycle', 'biology', 'birth', 'bitter', 'blade', 'blame', 'blast',
  'bless', 'blind', 'blossom', 'boost', 'border', 'bounce', 'bracket', 'brave',
  'bridge', 'brief', 'bright', 'brisk', 'broken', 'brother', 'bubble', 'bullet',
  'bundle', 'burden', 'burst', 'business', 'butter', 'cable', 'cactus', 'canvas',
  'capable', 'captain', 'carbon', 'cargo', 'carry', 'castle', 'casual', 'catalog',
  'cause', 'caution', 'cement', 'century', 'cereal', 'champion', 'chapter', 'charge',
  'chase', 'cheap', 'chest', 'chief', 'child', 'choice', 'circuit', 'citizen',
  'civil', 'claim', 'clever', 'client', 'climb', 'clinic', 'clog', 'cloth',
  'cloud', 'cluster', 'clutch', 'coast', 'coconut', 'combine', 'comfort', 'company',
  'confirm', 'congress', 'connect', 'consider', 'control', 'convince', 'copper', 'coral',
  'correct', 'cotton', 'country', 'couple', 'cousin', 'cover', 'crack', 'cradle',
  'craft', 'crane', 'crash', 'cream', 'cricket', 'crime', 'crisp', 'cross',
  'crucial', 'crystal', 'culture', 'curious', 'current', 'custom', 'cycle', 'damage',
  'danger', 'daring', 'daughter', 'decade', 'decline', 'define', 'delay', 'deliver',
  'demand', 'dental', 'derive', 'describe', 'design', 'detect', 'develop', 'device',
  'diagram', 'diamond', 'digital', 'dilemma', 'discover', 'display', 'domain', 'donate',
  'double', 'dragon', 'drama', 'draw', 'dream', 'dress', 'drift', 'drive',
  'dynamic', 'eagle', 'economy', 'effort', 'eight', 'electric', 'element', 'elite',
  'emerge', 'emotion', 'employ', 'enable', 'endorse', 'energy', 'enforce', 'engage',
  'engine', 'enjoy', 'enough', 'enrich', 'enter', 'equal', 'equip', 'escape',
  'estate', 'ethics', 'evidence', 'evolve', 'exact', 'excess', 'excite', 'exercise',
  'exhaust', 'exist', 'expand', 'explain', 'expose', 'extend', 'fabric', 'faculty',
  'faith', 'famous', 'fantasy', 'fashion', 'feature', 'festival', 'fiction', 'figure',
  'filter', 'fiscal', 'fitness', 'flame', 'flavor', 'flight', 'float', 'flower',
  'fluid', 'focus', 'forest', 'fortune', 'fossil', 'frame', 'frequent', 'fresh',
  'future', 'galaxy', 'gallery', 'garlic', 'gather', 'genius', 'genuine', 'ghost',
  'giant', 'ginger', 'giraffe', 'global', 'gospel', 'govern', 'grace', 'grain',
  'grape', 'gravity', 'great', 'guard', 'guide', 'guitar', 'habit', 'harvest',
  'hazard', 'health', 'heavy', 'height', 'hidden', 'history', 'hobby', 'hockey',
  'holiday', 'honey', 'hospital', 'hover', 'humble', 'humor', 'hybrid', 'icon',
  'ignore', 'illegal', 'image', 'immune', 'impact', 'improve', 'impulse', 'income',
  'indoor', 'industry', 'infant', 'innocent', 'inquiry', 'inspire', 'install', 'intact',
  'invest', 'invite', 'island', 'isolate', 'jacket', 'jaguar', 'jealous', 'journey',
  'jungle', 'kangaroo', 'kingdom', 'kitchen', 'knowledge', 'language', 'laptop', 'laundry',
  'lawsuit', 'leader', 'lecture', 'legend', 'liberty', 'license', 'liquid', 'lottery',
  'luggage', 'luxury', 'magic', 'magnet', 'marble', 'margin', 'marine', 'master',
  'matrix', 'meadow', 'melody', 'memory', 'mentor', 'mercy', 'middle', 'midnight',
  'miracle', 'mitten', 'monitor', 'monkey', 'moral', 'morning', 'mountain', 'museum',
  'mystery', 'nature', 'network', 'neutral', 'noble', 'nominee', 'nuclear', 'object',
  'obtain', 'ocean', 'olympic', 'onion', 'orbit', 'orchard', 'order', 'organ',
  'orphan', 'ostrich', 'output', 'oxygen', 'paddle', 'palace', 'panic', 'patrol',
  'payment', 'peasant', 'pelican', 'penalty', 'perfect', 'permit', 'phrase', 'physical',
  'pioneer', 'pistol', 'planet', 'plastic', 'pledge', 'polar', 'popular', 'portrait',
  'pottery', 'poverty', 'predict', 'preserve', 'primary', 'priority', 'prison', 'produce',
  'profit', 'program', 'promote', 'property', 'protect', 'provide', 'pudding', 'quantum',
  'question', 'rabbit', 'raccoon', 'radar', 'rainbow', 'rally', 'random', 'rebel',
  'rebuild', 'recall', 'recipe', 'reduce', 'reform', 'region', 'regular', 'release',
  'remain', 'remind', 'rescue', 'resist', 'resource', 'result', 'retire', 'reunion',
  'reveal', 'reward', 'rhythm', 'ribbon', 'ritual', 'robust', 'romance', 'rookie',
  'rotate', 'satellite', 'satisfy', 'scatter', 'science', 'scorpion', 'screen', 'second',
  'section', 'security', 'segment', 'seminar', 'separate', 'shadow', 'sheriff', 'shield',
  'signal', 'silent', 'similar', 'simple', 'siren', 'social', 'solar', 'soldier',
  'solution', 'someone', 'source', 'space', 'spatial', 'spawn', 'special', 'sphere',
  'spirit', 'sponsor', 'stable', 'stadium', 'stairs', 'strategy', 'street', 'struggle',
  'student', 'style', 'submit', 'subway', 'surface', 'surprise', 'sustain', 'symbol',
  'symptom', 'tackle', 'talent', 'target', 'texture', 'theory', 'thunder', 'timber',
  'tissue', 'token', 'tornado', 'tourist', 'traffic', 'tragic', 'transfer', 'trigger',
  'trophy', 'trumpet', 'tunnel', 'unique', 'universe', 'unlock', 'unusual', 'upgrade',
  'uphold', 'urban', 'utility', 'vacant', 'valley', 'vendor', 'venture', 'verify',
  'vibrant', 'victory', 'vintage', 'virtual', 'vital', 'vivid', 'volcano', 'voyage',
  'walnut', 'warfare', 'warrior', 'wealth', 'weapon', 'wedding', 'whisper', 'wildlife',
  'wisdom', 'witness', 'wonder', 'wrist', 'yellow', 'zebra', 'zero',
];

/** Entropy of a 12-word phrase drawn uniformly from this list: 12 * log2(575). */
export const SEED_PHRASE_WORDS = 12;
export const SEED_PHRASE_BITS = Math.round(SEED_PHRASE_WORDS * Math.log2(WORDLIST.length));

export default WORDLIST;
