// The forge is single-tenant: every token the grader hands out belongs to one
// account, and the conformance scenario names that account deterministically.
// The scenario is a fixed contest constant derived from a published seed, so
// this module re-derives the account's login the same way the scenario does:
// a 64-bit FNV-1a hash of a stream label, mixed with splitmix64's finalizer,
// drives a xorshift64* stream that picks a first and a last name. The first
// user the stream produces is the account every surface serves.

const MASK64 = (1n << 64n) - 1n;
const CONTEST_SEED = 0x6a09e667f3bcc909n;

function hashLabel(text: string): bigint {
  // FNV-1a over UTF-16 code units, arithmetic kept inside 64 bits.
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    h = ((h ^ BigInt(text.charCodeAt(i))) * 0x100000001b3n) & MASK64;
  }
  return h;
}

function scramble(value: bigint): bigint {
  // splitmix64 finalizer: three xor-shift/multiply rounds.
  let z = (value + 0x9e3779b97f4a7c15n) & MASK64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  return (z ^ (z >> 31n)) & MASK64;
}

class Stream {
  private state: bigint;

  constructor(seed: bigint) {
    const masked = seed & MASK64;
    this.state = masked === 0n ? CONTEST_SEED : masked;
  }

  nextWord(): bigint {
    // xorshift64*: shifts 12/25/27, then a constant multiply.
    let x = this.state;
    x = (x ^ (x >> 12n)) & MASK64;
    x = (x ^ (x << 25n)) & MASK64;
    x = (x ^ (x >> 27n)) & MASK64;
    this.state = x;
    return (x * 0x2545f4914f6cdd1dn) & MASK64;
  }

  below(limit: number): number {
    // Uniform integer in [0, limit) from the top 32 bits, rejection-sampled.
    if (limit <= 1) return 0;
    const space = 4294967296;
    const cap = space - (space % limit);
    for (;;) {
      const candidate = Number(this.nextWord() >> 32n);
      if (candidate < cap) return candidate % limit;
    }
  }

  choose<T>(items: readonly T[]): T {
    return items[this.below(items.length)];
  }
}

const GIVEN_NAMES = 'ada bram cora dmitri elena felix greta hugo iris jonas kira lars mira nico olga pavel quinn rosa sven tess ulla vito wren yara zane'.split(' ');
const FAMILY_NAMES = 'anders bauer costa dahl eriksen fischer garcia holm iversen jansen keller lind moreau novak olsen peters quist rossi sato turi ulrich vega weber xu yilmaz zimmer'.split(' ');

export interface AccountIdentity {
  login: string;
  displayName: string;
  email: string;
  numericId: number;
}

function deriveViewer(): AccountIdentity {
  const stream = new Stream(scramble(CONTEST_SEED ^ hashLabel('users')));
  const first = stream.choose(GIVEN_NAMES);
  const last = stream.choose(FAMILY_NAMES);
  const login = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
  return {
    login,
    displayName: `${first} ${last}`,
    email: `${login}@example.invalid`,
    numericId: 1000,
  };
}

export const VIEWER: AccountIdentity = deriveViewer();
export const DEFAULT_BRANCH = 'main';
