export const GIOVANA_AGENT_ID = "a8b1e073-d32a-4c11-8b8b-0b15b829aec1";

export const giovanaPlans = [
  { id: "a8b1e073-d32a-4c11-8b8b-0b15b829aec2", name: "350Mb", speed: "350Mb", price: 89.90, order: 1 },
  { id: "a8b1e073-d32a-4c11-8b8b-0b15b829aec3", name: "Oferta Especial 600Mb", speed: "600Mb", price: 69.90, order: 2 },
  { id: "a8b1e073-d32a-4c11-8b8b-0b15b829aec4", name: "500Mega+60Gb (Celular)", speed: "500Mb + 60Gb", price: 129.90, order: 3 },
  { id: "a8b1e073-d32a-4c11-8b8b-0b15b829aec5", name: "1Gb+60Gb (Celular)", speed: "1Gb + 60Gb", price: 179.90, order: 4 },
] as const;

export const GIOVANA_RECOMMENDED_PLAN_ID = giovanaPlans[1].id;
