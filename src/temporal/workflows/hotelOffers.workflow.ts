import type { HotelOffersWorkflowInput, HotelOffersWorkflowResult } from '../shared';

// Placeholder until phase 4.
export async function hotelOffersWorkflow(
  _input: HotelOffersWorkflowInput,
): Promise<HotelOffersWorkflowResult> {
  return {
    offers: [],
    suppliersStatus: { A: 'up', B: 'up' },
    resultStatus: 'complete',
    decisions: [],
  };
}
