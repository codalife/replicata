export type ScenarioKind = 'none' | 'latency' | 'disconnect' | 'drop' | 'rate-limit' | 'malformed';

export interface Scenario {
  kind: ScenarioKind;
  latencyMultiplier?: number;  // 'latency': e.g. 2.0 = twice as slow
  disconnectAt?: number;       // 'disconnect': chunk index after which to cut
  dropStart?: number;          // 'drop': inclusive start
  dropEnd?: number;            // 'drop': inclusive end
  errorStatus?: number;        // 'rate-limit': status code, default 429
  errorBody?: string;          // 'rate-limit': response body
}

export const NO_SCENARIO: Scenario = { kind: 'none' };

export function corruptChunk(data: string): string {
  // Flip a middle byte to force invalid JSON if the chunk looks like SSE data
  if (data.length < 4) return '}';
  const i = Math.floor(data.length / 2);
  return data.slice(0, i) + '{' + data.slice(i + 1);
}
