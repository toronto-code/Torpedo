export class SeededRandom {
  private state: number;
  private spareGaussian: number | null = null;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x6d2b79f5;
  }

  next(): number {
    let value = (this.state += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }

  gaussian(mean = 0, sigma = 1): number {
    if (this.spareGaussian !== null) {
      const spare = this.spareGaussian;
      this.spareGaussian = null;
      return mean + sigma * spare;
    }
    const u = Math.max(Number.EPSILON, this.next());
    const v = this.next();
    const radius = Math.sqrt(-2 * Math.log(u));
    const angle = Math.PI * 2 * v;
    this.spareGaussian = radius * Math.sin(angle);
    return mean + sigma * radius * Math.cos(angle);
  }
}

export function deriveSeed(seed: number, stream: string): number {
  let hash = seed >>> 0;
  for (let i = 0; i < stream.length; i += 1) {
    hash ^= stream.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
