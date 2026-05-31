import { randomBytes, randomInt } from "node:crypto";
import { adjectives, animals, colors } from "unique-names-generator";

// Generate a memorable word-password like `blue-happy-otter` for Secure Mode. We draw the words from
// unique-names-generator's curated dictionaries but pick with node:crypto (randomInt) rather than the
// library's Math.random-based generator, so the password is cryptographically random — it guards a
// server. Three words from these lists is ~30 bits; the real protection is that it's only ever used
// once to mint a revocable session token (it never travels on normal requests).
export function generatePassword(): string {
  const pick = (list: string[]) => list[randomInt(list.length)];
  return [pick(colors), pick(adjectives), pick(animals)].join("-").toLowerCase();
}

export function generateAuthToken(): string {
  return randomBytes(32).toString("hex");
}
