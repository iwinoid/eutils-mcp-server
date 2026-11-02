import { SEQUENCE_DATABASES } from '../constants.js';
import { EUtilsError } from '../types.js';

export interface FetchFormat {
  rettype?: string;
  retmode?: string;
  label: string;
}

export interface SequenceOptions {
  strand?: number;
  seq_start?: number;
  seq_stop?: number;
  complexity?: number;
}

const PUBMED_FORMAT: FetchFormat = { rettype: 'abstract', retmode: 'text', label: 'abstract/text' };
const SEQUENCE_FORMAT: FetchFormat = { rettype: 'fasta', retmode: 'text', label: 'fasta/text' };
const PMC_TEXT_FORMAT: FetchFormat = { rettype: 'medline', retmode: 'text', label: 'medline/text' };
const NATIVE_FORMAT: FetchFormat = { label: 'the database default format' };

export function resolveFetchFormat(
  db: string,
  rettype: string | undefined,
  retmode: string | undefined,
): FetchFormat {
  const requestedType = rettype !== undefined && rettype.length > 0 ? rettype : undefined;
  const requestedMode = retmode !== undefined && retmode.length > 0 ? retmode : undefined;

  if (requestedMode === 'asn.1' && SEQUENCE_DATABASES.includes(db)) {
    throw new EUtilsError(
      'validation',
      `Binary ASN.1 is not supported for '${db}'.`,
      'Use retmode="xml" or rettype="fasta"/"gb" for sequence records. Text ASN.1 is available only for non-sequence databases.',
    );
  }

  if (requestedType !== undefined) {
    const mode = requestedMode ?? 'text';
    return { rettype: requestedType, retmode: mode, label: `${requestedType}/${mode}` };
  }

  if (requestedMode === 'text') {
    if (db === 'pubmed') return PUBMED_FORMAT;
    if (SEQUENCE_DATABASES.includes(db)) return SEQUENCE_FORMAT;
    if (db === 'pmc') return PMC_TEXT_FORMAT;
    return { retmode: 'text', label: 'text' };
  }

  if (requestedMode !== undefined) {
    return { retmode: requestedMode, label: requestedMode };
  }

  if (db === 'pubmed') return PUBMED_FORMAT;
  if (SEQUENCE_DATABASES.includes(db)) return SEQUENCE_FORMAT;
  return NATIVE_FORMAT;
}

export function resolveSequenceOptions(db: string, options: SequenceOptions): SequenceOptions {
  const requested =
    options.strand !== undefined ||
    options.seq_start !== undefined ||
    options.seq_stop !== undefined ||
    options.complexity !== undefined;
  if (!requested) return {};

  if (!SEQUENCE_DATABASES.includes(db)) {
    throw new EUtilsError(
      'validation',
      `Sequence options are only valid for sequence databases: ${SEQUENCE_DATABASES.join(', ')}.`,
      `Remove strand, seq_start, seq_stop, and complexity when db is '${db}'.`,
    );
  }
  if (options.strand !== undefined && db !== 'nuccore' && db !== 'nucleotide') {
    throw new EUtilsError(
      'validation',
      `strand is only supported for nuccore and nucleotide, not '${db}'.`,
      'Remove strand, or fetch from nuccore.',
    );
  }
  if (
    options.seq_start !== undefined &&
    options.seq_stop !== undefined &&
    options.seq_stop < options.seq_start
  ) {
    throw new EUtilsError(
      'validation',
      `seq_stop (${options.seq_stop}) is before seq_start (${options.seq_start}).`,
      'Pass a seq_stop greater than or equal to seq_start.',
    );
  }
  return options;
}
