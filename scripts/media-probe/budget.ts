export interface Charge {
  id: string
  estimateUsd: number
  costUsd?: number
  costSource?: string
  generationId?: string
}

export const CAP_USD = 3

export function exposure(charges: Charge[]): number {
  return charges.reduce((sum, row) => sum + (row.costUsd ?? row.estimateUsd), 0)
}

export function canReserve(charges: Charge[], estimate: number): boolean {
  return Number.isFinite(estimate) && estimate > 0 &&
    exposure(charges) + estimate <= CAP_USD
}

export function checkedCost(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}
