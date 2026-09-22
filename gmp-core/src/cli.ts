#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import http from 'http';
import readline from 'readline';
import { Writable } from 'stream';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import config, { loadConfig } from './config.js';
import type { GMPNodeManagerOptions } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getMetricsPort(): number {
  return config.GMP_METRICS_PORT || 9090;
}

/** stdout wrapper that can blank out what it echoes, for password entry. */
interface MutableStdout extends Writable {
  muted: boolean;
}

function askQuestion(query: string, silent: boolean = false): Promise<string> {
  return new Promise((resolve) => {
    const mutableStdout = new Writable({
      // `this` inside a Writable's write() is the stream itself, which the
      // built-in type says is a plain Writable. The muted flag is ours, added
      // just below, so the callback has to be told what `this` really is.
      write: function(this: MutableStdout, chunk: Buffer | string, encoding: BufferEncoding, callback: () => void): void {
        const str = chunk.toString();
        if (this.muted || (!this.muted && str.includes(query))) {
          process.stdout.write(chunk, encoding);
        } else if (str === '\n' || str === '\r\n') {
          process.stdout.write(chunk, encoding);
        } else {
          process.stdout.write('*');
        }
        callback();
      }
    }) as MutableStdout;
    mutableStdout.muted = false;

    const rl = readline.createInterface({
      input: process.stdin,
      output: mutableStdout,
      terminal: true
    });

    rl.question(query, (answer: string) => {
      rl.close();
      resolve(answer.trim());
    });

    if (silent) {
      mutableStdout.muted = true;
    }
  });
}

interface JsonResponse {
  [key: string]: unknown;
}

/**
 * The caller names the shape it expects. JSON.parse returns `any`, so one
 * assertion at the parse boundary is unavoidable; doing it here, once, is
 * better than each call site casting a JsonResponse into an unrelated type.
 */
function getJson<T = JsonResponse>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    http.get(url, (res: http.IncomingMessage) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Status Code: ${res.statusCode}`));
        return;
      }
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body) as T);
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

function postJson<T = JsonResponse>(url: string, data: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    const dataStr = JSON.stringify(data);
    const parsedUrl = new URL(url);
    const options: http.RequestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(dataStr)
      }
    };

    const req = http.request(options, (res: http.IncomingMessage) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body) as T & JsonResponse;
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error((parsed.error as string) || `HTTP ${res.statusCode}`));
          } else {
            resolve(parsed);
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(dataStr);
    req.end();
  });
}

function formatUptime(uptimeSeconds: number): string {
  if (uptimeSeconds < 60) return `${uptimeSeconds}s`;
  const minutes = Math.floor(uptimeSeconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${uptimeSeconds % 60}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatNumber(num: number): string {
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// The canonical BIP-39 English wordlist (2048 words), identical to the one the
// web app uses in src/utils/bip39.js. This was previously a hand-trimmed
// 99-word excerpt, which capped a 12-word phrase at ~79 bits of entropy
// instead of 132 and meant CLI-generated phrases used words the other
// clients did not recognise. Phrases are PBKDF2 inputs, not checksummed
// indices, so existing phrases keep deriving the same identity.
const BIP39_WORDS: string[] = [
  "abandon", "ability", "able", "about", "above", "absent", "absorb", "abstract", "absurd", "abuse",
  "access", "accident", "account", "accuse", "achieve", "acid", "acoustic", "acquire", "across", "act",
  "action", "actor", "actress", "actual", "adapt", "add", "addict", "address", "adjust", "admit", "adult",
  "advance", "advice", "aerobic", "affair", "afford", "afraid", "again", "age", "agent", "agree", "ahead",
  "aim", "air", "airport", "aisle", "alarm", "album", "alcohol", "alert", "alien", "all", "alley", "allow",
  "almost", "alone", "alpha", "already", "also", "alter", "always", "amateur", "amazing", "among", "amount",
  "amused", "analyst", "anchor", "ancient", "anger", "angle", "angry", "animal", "ankle", "announce",
  "annual", "another", "answer", "antenna", "antique", "anxiety", "any", "apart", "apology", "appear",
  "apple", "approve", "april", "arch", "arctic", "area", "arena", "argue", "arm", "armed", "armor", "army",
  "around", "arrange", "arrest", "arrive", "arrow", "art", "artefact", "artist", "artwork", "ask", "aspect",
  "assault", "asset", "assist", "assume", "asthma", "athlete", "atom", "attack", "attend", "attitude",
  "attract", "auction", "audit", "august", "aunt", "author", "auto", "autumn", "average", "avocado", "avoid",
  "awake", "aware", "away", "awesome", "awful", "awkward", "axis", "baby", "bachelor", "bacon", "badge",
  "bag", "balance", "balcony", "ball", "bamboo", "banana", "banner", "bar", "barely", "bargain", "barrel",
  "base", "basic", "basket", "battle", "beach", "bean", "beauty", "because", "become", "beef", "before",
  "begin", "behave", "behind", "believe", "below", "belt", "bench", "benefit", "best", "betray", "better",
  "between", "beyond", "bicycle", "bid", "bike", "bind", "biology", "bird", "birth", "bitter", "black",
  "blade", "blame", "blanket", "blast", "bleak", "bless", "blind", "blood", "blossom", "blouse", "blue",
  "blur", "blush", "board", "boat", "body", "boil", "bomb", "bone", "bonus", "book", "boost", "border",
  "boring", "borrow", "boss", "bottom", "bounce", "box", "boy", "bracket", "brain", "brand", "brass",
  "brave", "bread", "breeze", "brick", "bridge", "brief", "bright", "bring", "brisk", "broccoli", "broken",
  "bronze", "broom", "brother", "brown", "brush", "bubble", "buddy", "budget", "buffalo", "build", "bulb",
  "bulk", "bullet", "bundle", "bunker", "burden", "burger", "burst", "bus", "business", "busy", "butter",
  "buyer", "buzz", "cabbage", "cabin", "cable", "cactus", "cage", "cake", "call", "calm", "camera", "camp",
  "can", "canal", "cancel", "candy", "cannon", "canoe", "canvas", "canyon", "capable", "capital", "captain",
  "car", "carbon", "card", "cargo", "carpet", "carry", "cart", "case", "cash", "casino", "castle", "casual",
  "cat", "catalog", "catch", "category", "cattle", "caught", "cause", "caution", "cave", "ceiling", "celery",
  "cement", "census", "century", "cereal", "certain", "chair", "chalk", "champion", "change", "chaos",
  "chapter", "charge", "chase", "chat", "cheap", "check", "cheese", "chef", "cherry", "chest", "chicken",
  "chief", "child", "chimney", "choice", "choose", "chronic", "chuckle", "chunk", "churn", "cigar",
  "cinnamon", "circle", "citizen", "city", "civil", "claim", "clap", "clarify", "claw", "clay", "clean",
  "clerk", "clever", "click", "client", "cliff", "climb", "clinic", "clip", "clock", "clog", "close",
  "cloth", "cloud", "clown", "club", "clump", "cluster", "clutch", "coach", "coast", "coconut", "code",
  "coffee", "coil", "coin", "collect", "color", "column", "combine", "come", "comfort", "comic", "common",
  "company", "concert", "conduct", "confirm", "congress", "connect", "consider", "control", "convince",
  "cook", "cool", "copper", "copy", "coral", "core", "corn", "correct", "cost", "cotton", "couch", "country",
  "couple", "course", "cousin", "cover", "coyote", "crack", "cradle", "craft", "cram", "crane", "crash",
  "crater", "crawl", "crazy", "cream", "credit", "creek", "crew", "cricket", "crime", "crisp", "critic",
  "crop", "cross", "crouch", "crowd", "crucial", "cruel", "cruise", "crumble", "crunch", "crush", "cry",
  "crystal", "cube", "culture", "cup", "cupboard", "curious", "current", "curtain", "curve", "cushion",
  "custom", "cute", "cycle", "dad", "damage", "damp", "dance", "danger", "daring", "dash", "daughter",
  "dawn", "day", "deal", "debate", "debris", "decade", "december", "decide", "decline", "decorate",
  "decrease", "deer", "defense", "define", "defy", "degree", "delay", "deliver", "demand", "demise",
  "denial", "dentist", "deny", "depart", "depend", "deposit", "depth", "deputy", "derive", "describe",
  "desert", "design", "desk", "despair", "destroy", "detail", "detect", "develop", "device", "devote",
  "diagram", "dial", "diamond", "diary", "dice", "diesel", "diet", "differ", "digital", "dignity", "dilemma",
  "dinner", "dinosaur", "direct", "dirt", "disagree", "discover", "disease", "dish", "dismiss", "disorder",
  "display", "distance", "divert", "divide", "divorce", "dizzy", "doctor", "document", "dog", "doll",
  "dolphin", "domain", "donate", "donkey", "donor", "door", "dose", "double", "dove", "draft", "dragon",
  "drama", "drastic", "draw", "dream", "dress", "drift", "drill", "drink", "drip", "drive", "drop", "drum",
  "dry", "duck", "dumb", "dune", "during", "dust", "dutch", "duty", "dwarf", "dynamic", "eager", "eagle",
  "early", "earn", "earth", "easily", "east", "easy", "echo", "ecology", "economy", "edge", "edit",
  "educate", "effort", "egg", "eight", "either", "elbow", "elder", "electric", "elegant", "element",
  "elephant", "elevator", "elite", "else", "embark", "embody", "embrace", "emerge", "emotion", "employ",
  "empower", "empty", "enable", "enact", "end", "endless", "endorse", "enemy", "energy", "enforce", "engage",
  "engine", "enhance", "enjoy", "enlist", "enough", "enrich", "enroll", "ensure", "enter", "entire", "entry",
  "envelope", "episode", "equal", "equip", "era", "erase", "erode", "erosion", "error", "erupt", "escape",
  "essay", "essence", "estate", "eternal", "ethics", "evidence", "evil", "evoke", "evolve", "exact",
  "example", "excess", "exchange", "excite", "exclude", "excuse", "execute", "exercise", "exhaust",
  "exhibit", "exile", "exist", "exit", "exotic", "expand", "expect", "expire", "explain", "expose",
  "express", "extend", "extra", "eye", "eyebrow", "fabric", "face", "faculty", "fade", "faint", "faith",
  "fall", "false", "fame", "family", "famous", "fan", "fancy", "fantasy", "farm", "fashion", "fat", "fatal",
  "father", "fatigue", "fault", "favorite", "feature", "february", "federal", "fee", "feed", "feel",
  "female", "fence", "festival", "fetch", "fever", "few", "fiber", "fiction", "field", "figure", "file",
  "film", "filter", "final", "find", "fine", "finger", "finish", "fire", "firm", "first", "fiscal", "fish",
  "fit", "fitness", "fix", "flag", "flame", "flash", "flat", "flavor", "flee", "flight", "flip", "float",
  "flock", "floor", "flower", "fluid", "flush", "fly", "foam", "focus", "fog", "foil", "fold", "follow",
  "food", "foot", "force", "forest", "forget", "fork", "fortune", "forum", "forward", "fossil", "foster",
  "found", "fox", "fragile", "frame", "frequent", "fresh", "friend", "fringe", "frog", "front", "frost",
  "frown", "frozen", "fruit", "fuel", "fun", "funny", "furnace", "fury", "future", "gadget", "gain",
  "galaxy", "gallery", "game", "gap", "garage", "garbage", "garden", "garlic", "garment", "gas", "gasp",
  "gate", "gather", "gauge", "gaze", "general", "genius", "genre", "gentle", "genuine", "gesture", "ghost",
  "giant", "gift", "giggle", "ginger", "giraffe", "girl", "give", "glad", "glance", "glare", "glass",
  "glide", "glimpse", "globe", "gloom", "glory", "glove", "glow", "glue", "goat", "goddess", "gold", "good",
  "goose", "gorilla", "gospel", "gossip", "govern", "gown", "grab", "grace", "grain", "grant", "grape",
  "grass", "gravity", "great", "green", "grid", "grief", "grit", "grocery", "group", "grow", "grunt",
  "guard", "guess", "guide", "guilt", "guitar", "gun", "gym", "habit", "hair", "half", "hammer", "hamster",
  "hand", "happy", "harbor", "hard", "harsh", "harvest", "hat", "have", "hawk", "hazard", "head", "health",
  "heart", "heavy", "hedgehog", "height", "hello", "helmet", "help", "hen", "hero", "hidden", "high", "hill",
  "hint", "hip", "hire", "history", "hobby", "hockey", "hold", "hole", "holiday", "hollow", "home", "honey",
  "hood", "hope", "horn", "horror", "horse", "hospital", "host", "hotel", "hour", "hover", "hub", "huge",
  "human", "humble", "humor", "hundred", "hungry", "hunt", "hurdle", "hurry", "hurt", "husband", "hybrid",
  "ice", "icon", "idea", "identify", "idle", "ignore", "ill", "illegal", "illness", "image", "imitate",
  "immense", "immune", "impact", "impose", "improve", "impulse", "inch", "include", "income", "increase",
  "index", "indicate", "indoor", "industry", "infant", "inflict", "inform", "inhale", "inherit", "initial",
  "inject", "injury", "inmate", "inner", "innocent", "input", "inquiry", "insane", "insect", "inside",
  "inspire", "install", "intact", "interest", "into", "invest", "invite", "involve", "iron", "island",
  "isolate", "issue", "item", "ivory", "jacket", "jaguar", "jar", "jazz", "jealous", "jeans", "jelly",
  "jewel", "job", "join", "joke", "journey", "joy", "judge", "juice", "jump", "jungle", "junior", "junk",
  "just", "kangaroo", "keen", "keep", "ketchup", "key", "kick", "kid", "kidney", "kind", "kingdom", "kiss",
  "kit", "kitchen", "kite", "kitten", "kiwi", "knee", "knife", "knock", "know", "lab", "label", "labor",
  "ladder", "lady", "lake", "lamp", "language", "laptop", "large", "later", "latin", "laugh", "laundry",
  "lava", "law", "lawn", "lawsuit", "layer", "lazy", "leader", "leaf", "learn", "leave", "lecture", "left",
  "leg", "legal", "legend", "leisure", "lemon", "lend", "length", "lens", "leopard", "lesson", "letter",
  "level", "liar", "liberty", "library", "license", "life", "lift", "light", "like", "limb", "limit", "link",
  "lion", "liquid", "list", "little", "live", "lizard", "load", "loan", "lobster", "local", "lock", "logic",
  "lonely", "long", "loop", "lottery", "loud", "lounge", "love", "loyal", "lucky", "luggage", "lumber",
  "lunar", "lunch", "luxury", "lyrics", "machine", "mad", "magic", "magnet", "maid", "mail", "main", "major",
  "make", "mammal", "man", "manage", "mandate", "mango", "mansion", "manual", "maple", "marble", "march",
  "margin", "marine", "market", "marriage", "mask", "mass", "master", "match", "material", "math", "matrix",
  "matter", "maximum", "maze", "meadow", "mean", "measure", "meat", "mechanic", "medal", "media", "melody",
  "melt", "member", "memory", "mention", "menu", "mercy", "merge", "merit", "merry", "mesh", "message",
  "metal", "method", "middle", "midnight", "milk", "million", "mimic", "mind", "minimum", "minor", "minute",
  "miracle", "mirror", "misery", "miss", "mistake", "mix", "mixed", "mixture", "mobile", "model", "modify",
  "mom", "moment", "monitor", "monkey", "monster", "month", "moon", "moral", "more", "morning", "mosquito",
  "mother", "motion", "motor", "mountain", "mouse", "move", "movie", "much", "muffin", "mule", "multiply",
  "muscle", "museum", "mushroom", "music", "must", "mutual", "myself", "mystery", "myth", "naive", "name",
  "napkin", "narrow", "nasty", "nation", "nature", "near", "neck", "need", "negative", "neglect", "neither",
  "nephew", "nerve", "nest", "net", "network", "neutral", "never", "news", "next", "nice", "night", "noble",
  "noise", "nominee", "noodle", "normal", "north", "nose", "notable", "note", "nothing", "notice", "novel",
  "now", "nuclear", "number", "nurse", "nut", "oak", "obey", "object", "oblige", "obscure", "observe",
  "obtain", "obvious", "occur", "ocean", "october", "odor", "off", "offer", "office", "often", "oil", "okay",
  "old", "olive", "olympic", "omit", "once", "one", "onion", "online", "only", "open", "opera", "opinion",
  "oppose", "option", "orange", "orbit", "orchard", "order", "ordinary", "organ", "orient", "original",
  "orphan", "ostrich", "other", "outdoor", "outer", "output", "outside", "oval", "oven", "over", "own",
  "owner", "oxygen", "oyster", "ozone", "pact", "paddle", "page", "pair", "palace", "palm", "panda", "panel",
  "panic", "panther", "paper", "parade", "parent", "park", "parrot", "party", "pass", "patch", "path",
  "patient", "patrol", "pattern", "pause", "pave", "payment", "peace", "peanut", "pear", "peasant",
  "pelican", "pen", "penalty", "pencil", "people", "pepper", "perfect", "permit", "person", "pet", "phone",
  "photo", "phrase", "physical", "piano", "picnic", "picture", "piece", "pig", "pigeon", "pill", "pilot",
  "pink", "pioneer", "pipe", "pistol", "pitch", "pizza", "place", "planet", "plastic", "plate", "play",
  "please", "pledge", "pluck", "plug", "plunge", "poem", "poet", "point", "polar", "pole", "police", "pond",
  "pony", "pool", "popular", "portion", "position", "possible", "post", "potato", "pottery", "poverty",
  "powder", "power", "practice", "praise", "predict", "prefer", "prepare", "present", "pretty", "prevent",
  "price", "pride", "primary", "print", "priority", "prison", "private", "prize", "problem", "process",
  "produce", "profit", "program", "project", "promote", "proof", "property", "prosper", "protect", "proud",
  "provide", "public", "pudding", "pull", "pulp", "pulse", "pumpkin", "punch", "pupil", "puppy", "purchase",
  "purity", "purpose", "purse", "push", "put", "puzzle", "pyramid", "quality", "quantum", "quarter",
  "question", "quick", "quit", "quiz", "quote", "rabbit", "raccoon", "race", "rack", "radar", "radio",
  "rail", "rain", "raise", "rally", "ramp", "ranch", "random", "range", "rapid", "rare", "rate", "rather",
  "raven", "raw", "razor", "ready", "real", "reason", "rebel", "rebuild", "recall", "receive", "recipe",
  "record", "recycle", "reduce", "reflect", "reform", "refuse", "region", "regret", "regular", "reject",
  "relax", "release", "relief", "rely", "remain", "remember", "remind", "remove", "render", "renew", "rent",
  "reopen", "repair", "repeat", "replace", "report", "require", "rescue", "resemble", "resist", "resource",
  "response", "result", "retire", "retreat", "return", "reunion", "reveal", "review", "reward", "rhythm",
  "rib", "ribbon", "rice", "rich", "ride", "ridge", "rifle", "right", "rigid", "ring", "riot", "ripple",
  "risk", "ritual", "rival", "river", "road", "roast", "robot", "robust", "rocket", "romance", "roof",
  "rookie", "room", "rose", "rotate", "rough", "round", "route", "royal", "rubber", "rude", "rug", "rule",
  "run", "runway", "rural", "sad", "saddle", "sadness", "safe", "sail", "salad", "salmon", "salon", "salt",
  "salute", "same", "sample", "sand", "satisfy", "satoshi", "sauce", "sausage", "save", "say", "scale",
  "scan", "scare", "scatter", "scene", "scheme", "school", "science", "scissors", "scorpion", "scout",
  "scrap", "screen", "script", "scrub", "sea", "search", "season", "seat", "second", "secret", "section",
  "security", "seed", "seek", "segment", "select", "sell", "seminar", "senior", "sense", "sentence",
  "series", "service", "session", "settle", "setup", "seven", "shadow", "shaft", "shallow", "share", "shed",
  "shell", "sheriff", "shield", "shift", "shine", "ship", "shiver", "shock", "shoe", "shoot", "shop",
  "short", "shoulder", "shove", "shrimp", "shrug", "shuffle", "shy", "sibling", "sick", "side", "siege",
  "sight", "sign", "silent", "silk", "silly", "silver", "similar", "simple", "since", "sing", "siren",
  "sister", "situate", "six", "size", "skate", "sketch", "ski", "skill", "skin", "skirt", "skull", "slab",
  "slam", "sleep", "slender", "slice", "slide", "slight", "slim", "slogan", "slot", "slow", "slush", "small",
  "smart", "smile", "smoke", "smooth", "snack", "snake", "snap", "sniff", "snow", "soap", "soccer", "social",
  "sock", "soda", "soft", "solar", "soldier", "solid", "solution", "solve", "someone", "song", "soon",
  "sorry", "sort", "soul", "sound", "soup", "source", "south", "space", "spare", "spatial", "spawn", "speak",
  "special", "speed", "spell", "spend", "sphere", "spice", "spider", "spike", "spin", "spirit", "split",
  "spoil", "sponsor", "spoon", "sport", "spot", "spray", "spread", "spring", "spy", "square", "squeeze",
  "squirrel", "stable", "stadium", "staff", "stage", "stairs", "stamp", "stand", "start", "state", "stay",
  "steak", "steel", "stem", "step", "stereo", "stick", "still", "sting", "stock", "stomach", "stone",
  "stool", "story", "stove", "strategy", "street", "strike", "strong", "struggle", "student", "stuff",
  "stumble", "style", "subject", "submit", "subway", "success", "such", "sudden", "suffer", "sugar",
  "suggest", "suit", "summer", "sun", "sunny", "sunset", "super", "supply", "supreme", "sure", "surface",
  "surge", "surprise", "surround", "survey", "suspect", "sustain", "swallow", "swamp", "swap", "swarm",
  "swear", "sweet", "swift", "swim", "swing", "switch", "sword", "symbol", "symptom", "syrup", "system",
  "table", "tackle", "tag", "tail", "talent", "talk", "tank", "tape", "target", "task", "taste", "tattoo",
  "taxi", "teach", "team", "tell", "ten", "tenant", "tennis", "tent", "term", "test", "text", "thank",
  "that", "theme", "then", "theory", "there", "they", "thing", "this", "thought", "three", "thrive", "throw",
  "thumb", "thunder", "ticket", "tide", "tiger", "tilt", "timber", "time", "tiny", "tip", "tired", "tissue",
  "title", "toast", "tobacco", "today", "toddler", "toe", "together", "toilet", "token", "tomato",
  "tomorrow", "tone", "tongue", "tonight", "tool", "tooth", "top", "topic", "topple", "torch", "tornado",
  "tortoise", "toss", "total", "tourist", "toward", "tower", "town", "toy", "track", "trade", "traffic",
  "tragic", "train", "transfer", "trap", "trash", "travel", "tray", "treat", "tree", "trend", "trial",
  "tribe", "trick", "trigger", "trim", "trip", "trophy", "trouble", "truck", "true", "truly", "trumpet",
  "trust", "truth", "try", "tube", "tuition", "tumble", "tuna", "tunnel", "turkey", "turn", "turtle",
  "twelve", "twenty", "twice", "twin", "twist", "two", "type", "typical", "ugly", "umbrella", "unable",
  "unaware", "uncle", "uncover", "under", "undo", "unfair", "unfold", "unhappy", "uniform", "unique", "unit",
  "universe", "unknown", "unlock", "until", "unusual", "unveil", "update", "upgrade", "uphold", "upon",
  "upper", "upset", "urban", "urge", "usage", "use", "used", "useful", "useless", "usual", "utility",
  "vacant", "vacuum", "vague", "valid", "valley", "valve", "van", "vanish", "vapor", "various", "vast",
  "vault", "vehicle", "velvet", "vendor", "venture", "venue", "verb", "verify", "version", "very", "vessel",
  "veteran", "viable", "vibrant", "vicious", "victory", "video", "view", "village", "vintage", "violin",
  "virtual", "virus", "visa", "visit", "visual", "vital", "vivid", "vocal", "voice", "void", "volcano",
  "volume", "vote", "voyage", "wage", "wagon", "wait", "walk", "wall", "walnut", "want", "warfare", "warm",
  "warrior", "wash", "wasp", "waste", "water", "wave", "way", "wealth", "weapon", "wear", "weasel",
  "weather", "web", "wedding", "weekend", "weird", "welcome", "west", "wet", "whale", "what", "wheat",
  "wheel", "when", "where", "whip", "whisper", "wide", "width", "wife", "wild", "will", "win", "window",
  "wine", "wing", "wink", "winner", "winter", "wire", "wisdom", "wise", "wish", "witness", "wolf", "woman",
  "wonder", "wood", "wool", "word", "work", "world", "worry", "worth", "wrap", "wreck", "wrestle", "wrist",
  "write", "wrong", "yard", "year", "yellow", "you", "young", "youth", "zebra", "zero", "zone", "zoo"
];

/**
 * Uniform random index in [0, max) from the platform CSPRNG.
 *
 * Rejection sampling rather than `% max`: 2^32 is not a multiple of the word
 * list length, so the plain modulo made the first (2^32 % max) words more
 * likely than the rest and shaved entropy off every phrase it generated.
 */
function secureRandomIndex(max: number): number {
  const webCrypto = globalThis.crypto || (crypto as unknown as { webcrypto: Crypto }).webcrypto;
  if (!webCrypto || typeof webCrypto.getRandomValues !== 'function') {
    // A predictable seed phrase is a predictable identity key. There is no
    // safe degraded mode here, so fail loudly instead of producing one.
    throw new Error('No secure random source available — refusing to generate a seed phrase.');
  }
  const limit = Math.floor(0x100000000 / max) * max;
  const buf = new Uint32Array(1);
  let v: number;
  do {
    webCrypto.getRandomValues(buf);
    v = buf[0];
  } while (v >= limit);
  return v % max;
}

/**
 * Generate a 12-word recovery phrase.
 *
 * This is the node's master identity: whoever can reproduce the phrase can
 * reproduce the key. It previously had a second, Math.random-backed
 * implementation that `rotate-key` called, which made a rotated identity
 * predictable from the PRNG state. There is now one generator, and it is
 * CSPRNG-backed.
 */
function generateSeedPhrase(): string {
  const words: string[] = [];
  for (let i = 0; i < 12; i++) {
    words.push(BIP39_WORDS[secureRandomIndex(BIP39_WORDS.length)]);
  }
  return words.join(' ');
}

const generateCryptoSeedPhrase = generateSeedPhrase;

async function startNode(isPublic: boolean = false): Promise<void> {
  let seedPhrase: string | undefined = process.env.GMP_SEED_PHRASE;

  if (seedPhrase) {
    const loggerModule = await import('./logger.js');
    const logger = loggerModule.default;
    logger.info('cli', 'env-seed-phrase', 'Using seed phrase from GMP_SEED_PHRASE environment variable');
  } else {
    seedPhrase = config.GMP_SEED_PHRASE;
    if (!seedPhrase) {
      console.log('No seed phrase configured.');
      seedPhrase = await askQuestion('Enter 12-word seed phrase: ', true);
    }
    if (!seedPhrase || seedPhrase.split(/\s+/).length !== 12) {
      console.error('Invalid seed phrase. Must be exactly 12 words.');
      process.exit(1);
    }
  }

  const { GMPNodeManager } = await import('./gmp-node-manager.js');
  const { startBridge } = await import('./gmp-bridge.js');

  const options: Record<string, unknown> = { seedPhrase };
  if (isPublic) {
    options.isPublicPeer = true;
    if (process.env.PORT) {
      const port = parseInt(process.env.PORT, 10);
      options.GMP_PORT = port;
      const loggerModule = await import('./logger.js');
      const logger = loggerModule.default;
      logger.info('cli', 'port-select', `Using port ${port} from PORT environment variable for GMP public-peer`);
    } else {
      const port = config.GMP_PORT || 49500;
      options.GMP_PORT = port;
      const loggerModule = await import('./logger.js');
      const logger = loggerModule.default;
      logger.info('cli', 'port-select', `Using port ${port} for GMP public-peer`);
    }
  } else {
    const port = config.GMP_PORT || 49500;
    options.GMP_PORT = port;
    const loggerModule = await import('./logger.js');
    const logger = loggerModule.default;
    logger.info('cli', 'port-select', `Using port ${port} for GMP node`);
  }

  console.log(`Starting Ghost Link Node (isPublicPeer=${isPublic || false})...`);
  const manager = new GMPNodeManager(options as GMPNodeManagerOptions);

  try {
    const status = await manager.start();
    console.log(`GMP Node successfully started. NodeID: ${status.nodeId}`);

    startBridge(manager, config.GMP_BRIDGE_PORT, config.GMP_BRIDGE_HOST);

    const shutdown = async (): Promise<void> => {
      console.log('\nShutting down GMP node gracefully...');
      await manager.stop();
      console.log('GMP node stopped.');
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (e) {
    const err = e as Error;
    console.error('Failed to start GMP Node:', err.message);
    process.exit(1);
  }
}

interface MetricsData {
  node: { nodeId: string; uptimeSeconds: number };
  peers: { current: number };
  routing: { tableSize: number; messagesForwarded: number };
  bootstrap: { status: string };
}

interface PeersData {
  nodeId: string;
  address: string;
  port: number;
  type: string;
  isVirtual: boolean;
}

interface RotateResponse {
  newNodeId: string;
}

interface PingResponse {
  rtt: number;
  hops: number;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  const metricsUrl = `http://127.0.0.1:${getMetricsPort()}`;

  switch (command) {
    case 'generate-seed': {
      const seed = generateCryptoSeedPhrase();
      console.log(seed);
      break;
    }
    case 'start': {
      await startNode(false);
      break;
    }
    case 'public-peer': {
      await startNode(true);
      break;
    }
    case 'status': {
      try {
        const data = await getJson<MetricsData>(`${metricsUrl}/metrics`);
        const uptimeStr = formatUptime(data.node.uptimeSeconds);
        const peersCount = `${data.peers.current} connected`;
        const routesCount = `${data.routing.tableSize} known`;
        const forwardedStr = `${formatNumber(data.routing.messagesForwarded)} messages`;
        const statusStr = data.bootstrap.status.charAt(0).toUpperCase() + data.bootstrap.status.slice(1);

        console.log('┌─────────────────────────────┐');
        console.log('│ GhostLink Node Status       │');
        console.log('├─────────────────────────────┤');
        console.log(`│ NodeID:    ${data.node.nodeId.slice(0, 12)}...     │`);
        console.log(`│ Uptime:    ${uptimeStr.padEnd(17)} │`);
        console.log(`│ Peers:     ${peersCount.padEnd(17)} │`);
        console.log(`│ Routes:    ${routesCount.padEnd(17)} │`);
        console.log(`│ Forwarded: ${forwardedStr.padEnd(17)} │`);
        console.log(`│ Status:    ${statusStr.padEnd(17)} │`);
        console.log('└─────────────────────────────┘');
      } catch (e) {
        console.error('No GMP node running. Start with: gmp start');
      }
      break;
    }
    case 'peers': {
      try {
        const peers = await getJson<PeersData[]>(`${metricsUrl}/peers`);
        if (peers.length === 0) {
          console.log('No active peer connections.');
          return;
        }
        console.log(`Connected Peers (${peers.length}):`);
        console.log('─'.repeat(70));
        for (const p of peers) {
          const nodeIdTrunc = p.nodeId.slice(0, 16) + '...';
          const typeStr = p.type.toUpperCase();
          const virtualStr = p.isVirtual ? ' (VIRTUAL)' : '';

          let addrStr = p.address;
          if (addrStr && addrStr.includes('.')) {
            const parts = addrStr.split('.');
            if (parts.length >= 3) addrStr = parts.slice(0, 3).join('.') + '.x';
          } else if (addrStr && addrStr.includes(':')) {
            const parts = addrStr.split(':');
            if (parts.length >= 3) addrStr = parts.slice(0, 3).join(':') + ':x';
          }

          const fullAddr = p.isVirtual ? 'virtual' : `${addrStr}:${p.port}`;
          console.log(`NodeID: ${nodeIdTrunc.padEnd(20)} | Address: ${fullAddr.padEnd(24)} | Type: ${typeStr}${virtualStr}`);
        }
        console.log('─'.repeat(70));
      } catch (e) {
        console.error('No GMP node running. Start with: gmp start');
      }
      break;
    }
    case 'rotate-key': {
      try {
        await getJson(`${metricsUrl}/health`);
      } catch (e) {
        console.error('No GMP node running. Start the node before rotating keys.');
        return;
      }

      console.log('=== GhostLink Key Rotation ===');
      console.log('Generating new 12-word seed phrase...');
      const newSeed = generateSeedPhrase();
      console.log('\n----------------------------------------');
      console.log('Your new seed phrase is:');
      console.log(newSeed);
      console.log('----------------------------------------');
      console.log('\nIMPORTANT: Write down this new seed phrase. It will replace your current static key.');

      const written = await askQuestion('\nHave you written this phrase down securely? (y/n): ');
      if (written.toLowerCase() !== 'y') {
        console.log('Rotation aborted.');
        return;
      }

      const confirm = await askQuestion('Are you sure you want to rotate your identity keys now? (y/n): ');
      if (confirm.toLowerCase() !== 'y') {
        console.log('Rotation aborted.');
        return;
      }

      try {
        console.log('Initiating rotation flood across the mesh...');
        const res = await postJson<RotateResponse>(`${metricsUrl}/rotate-key`, { newSeedPhrase: newSeed });
        console.log(`\nSuccess! Node identity successfully rotated.`);
        console.log(`New NodeID: ${res.newNodeId}`);
        console.log('The rotation certificate has been flooded. Your configuration files have been updated.');
      } catch (e) {
        const err = e as Error;
        console.error('Rotation failed:', err.message);
      }
      break;
    }
    case 'ping': {
      const target = args[1];
      if (!target) {
        console.error('Usage: gmp ping <nodeId>');
        return;
      }
      try {
        console.log(`Sending virtual ping to ${target.slice(0, 16)}...`);
        const res = await postJson<PingResponse>(`${metricsUrl}/ping`, { targetNodeId: target });
        console.log(`Ping success! RTT = ${res.rtt}ms, Hops = ${res.hops}`);
      } catch (e) {
        const err = e as Error;
        console.error(`Ping failed: ${err.message}`);
      }
      break;
    }
    default: {
      console.error(`Unknown command: ${command}`);
      printHelp();
      break;
    }
  }
}

function printHelp(): void {
  console.log('GhostMesh Protocol (GMP) Operator CLI');
  console.log('\nUsage:');
  console.log('  gmp start           Starts the GMP node and client bridge');
  console.log('  gmp public-peer     Starts the node as a Public Peer');
  console.log('  gmp status          Queries local node metrics and prints status box');
  console.log('  gmp peers           Lists currently connected peers');
  console.log('  gmp rotate-key      Walks through seed generation and rotating identity keys');
  console.log('  gmp ping <nodeId>   Pings a NodeID through the multi-hop mesh');
  console.log('  gmp generate-seed   Generates a cryptographically random 12-word seed phrase');
}

main().catch((err: unknown) => {
  const error = err as Error;
  console.error('Fatal CLI Error:', error);
  process.exit(1);
});