import { Dictionary, Field, Float64, Int8, Int32, Int64, Schema, Utf8 } from 'apache-arrow';

// Spec §2.5 "Schema versioning": embedded in Parquet key-value metadata
// (wsr.schemaVersion) and in the .done marker. Readers refuse a mismatch.
export const SCHEMA_VERSION = 1;

export const SCHEMA_VERSION_METADATA_KEY = 'wsr.schemaVersion';

function dictionaryField(name: string): Field {
  return new Field(name, new Dictionary(new Utf8(), new Int32()), false);
}

function schemaMetadata(): Map<string, string> {
  return new Map([[SCHEMA_VERSION_METADATA_KEY, String(SCHEMA_VERSION)]]);
}

// Spec §2.3.1 raw-partition columns.
export function buildRawSchema(): Schema {
  return new Schema(
    [
      dictionaryField('venue'),
      dictionaryField('symbol'),
      new Field('tradeId', new Utf8(), false),
      new Field('t', new Int64(), false),
      new Field('tNsRemainder', new Int32(), false),
      new Field('seq', new Int64(), false),
      new Field('p', new Int64(), false),
      new Field('q', new Int64(), false),
      new Field('s', new Int8(), false),
    ],
    schemaMetadata(),
  );
}

// Spec §2.3.1 merged-partition columns.
export function buildMergedSchema(): Schema {
  return new Schema(
    [
      dictionaryField('venue'),
      dictionaryField('symbol'),
      new Field('t', new Int64(), false),
      new Field('seq', new Int64(), false),
      new Field('p', new Int64(), false),
      new Field('q', new Int64(), false),
      new Field('s', new Int8(), false),
      new Field('n', new Int32(), false),
      new Field('pFirst', new Int64(), false),
      new Field('rawSeqFirst', new Int64(), false),
    ],
    schemaMetadata(),
  );
}

// Spec §2.5 {dataRoot}/meta/{venue}/{symbol}/funding.parquet: signed funding
// rate per interval (Spec §2.1 FundingRecord).
export function buildFundingSchema(): Schema {
  return new Schema([new Field('t', new Int64(), false), new Field('rate', new Float64(), false)], schemaMetadata());
}
