export type Vec3 = [number, number, number];
export type SceneObject = {
  id: string; name: string; kind: 'led' | 'box' | 'panel';
  position: Vec3; rotation: Vec3; size: Vec3;
  power_w: number; reflectance: number; enabled: boolean;
};
export type Config = {
  version: 1;
  room: { width: number; length: number; height: number; enabled: boolean;
    wall_reflectance: number | null; floor_reflectance: number | null; ceiling_reflectance: number | null; };
  simulation: { days: number; rows: number; plants_per_row: number; density: number;
    border_rows: number; border_plants: number; seed: number; rays: number; photoperiod: number;
    plant_input: string; temperature_input: string; emission_input: string; spectrum_input: string; };
  objects: SceneObject[];
  spectrum: { wavelength: number; amplitude: number }[];
};
export type ConfigResponse = { config: Config; revision: string; installed: boolean; inputs: Record<string, string[]> };
export type Run = {
  id: string; name: string; status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  created_at: string; started_at: string | null; finished_at: string | null;
  days: number; current_day: number; cancel_requested: boolean; error: string | null;
  revision: string; config: Config; available_days?: number[];
  raw_available?: boolean;
};
export type Metric = {
  plant: number; model_age_days: number; biomass_g: number; fruit_g: number;
  leaf_area_m2: number; par_umol_s: number; par_mmol_day: number; carbon_mmol_day: number;
};
export type DailyResult = { day: number; plants: Metric[] };
export type Health = { status: string; worker: { ready: boolean; error?: string | null; gpu?: string | null; groimp?: string | null } };
export const artifactUrl = (id: string, path: string) => `/api/runs/${id}/artifacts/${path}`;
export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options, headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      message = typeof body.detail === 'string' ? body.detail : body.detail?.map((e: { msg: string; loc: string[] }) => `${e.loc.slice(1).join('.')}: ${e.msg}`).join('; ') || message;
    } catch { /* Preserve HTTP status for non-JSON errors. */ }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}
