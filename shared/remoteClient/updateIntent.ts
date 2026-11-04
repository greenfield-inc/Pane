import { boundary, decodeOptionalBoundary } from '../validation/boundaryDecoder';
const updateIntentSchema = boundary.object({
  protocol: boundary.literal(1), id: boundary.nonEmptyString, bootId: boundary.nonEmptyString,
  machine: boundary.nonEmptyString, phase: boundary.literal('checkpoint'), timestamp: boundary.nonEmptyString,
});
export type RemoteUpdateIntent = ReturnType<typeof updateIntentSchema.decode>;
export const decodeUpdateIntent = <Value>(value: Value) => decodeOptionalBoundary(value, updateIntentSchema);
