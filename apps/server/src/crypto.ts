import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const VERSION = "v1";

/** AES-256-GCM envelope for upstream secrets stored in SQLite. Format: v1.<iv>.<tag>.<ciphertext> (base64url). */
export class SecretBox {
  readonly #key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error("MASTER_KEY must decode to exactly 32 bytes");
    this.#key = key;
  }

  seal(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      VERSION,
      iv.toString("base64url"),
      tag.toString("base64url"),
      ct.toString("base64url"),
    ].join(".");
  }

  open(sealed: string): string {
    const [version, iv, tag, ct] = sealed.split(".");
    if (version !== VERSION || !iv || !tag || ct === undefined)
      throw new Error("unsupported secret format");
    const decipher = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ct, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }
}

export function hashKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/** 256-bit random virtual key. Only the hash is persisted; the prefix is kept for display. */
export function generateVirtualKey(): { plaintext: string; hash: string; prefix: string } {
  const plaintext = `sk-pp-${randomBytes(32).toString("base64url")}`;
  return { plaintext, hash: hashKey(plaintext), prefix: plaintext.slice(0, 12) };
}
