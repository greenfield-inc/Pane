import {
  decodeBoundary,
  type BoundarySchema,
} from '../../../shared/validation/boundaryDecoder';

export function serializeJsonTransport<Decoded>(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- JSON transport serializes an external value, then validates the result with the supplied schema.
  value: unknown,
  schema: BoundarySchema<Decoded>,
): Decoded {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error('JSON transport value is not serializable');
  }

  return decodeBoundary(JSON.parse(serialized), schema);
}
