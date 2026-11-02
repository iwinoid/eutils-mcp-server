import { describe, expect, it } from 'vitest';
import { EUtilsError } from '../src/types.js';
import { resolveFetchFormat, resolveSequenceOptions } from '../src/services/fetchFormats.js';

describe('resolveFetchFormat', () => {
  it('sends an explicit rettype and defaults retmode to text', () => {
    expect(resolveFetchFormat('pubmed', 'medline', undefined)).toEqual({
      rettype: 'medline',
      retmode: 'text',
      label: 'medline/text',
    });
  });

  it('sends both an explicit rettype and an explicit retmode', () => {
    expect(resolveFetchFormat('nuccore', 'fasta', 'xml')).toEqual({
      rettype: 'fasta',
      retmode: 'xml',
      label: 'fasta/xml',
    });
  });

  it('keeps PubMed abstracts as the default', () => {
    expect(resolveFetchFormat('pubmed', undefined, undefined)).toEqual({
      rettype: 'abstract',
      retmode: 'text',
      label: 'abstract/text',
    });
    expect(resolveFetchFormat('pubmed', undefined, 'text')).toEqual({
      rettype: 'abstract',
      retmode: 'text',
      label: 'abstract/text',
    });
  });

  it('keeps FASTA as the default for sequence databases', () => {
    expect(resolveFetchFormat('protein', undefined, undefined)).toEqual({
      rettype: 'fasta',
      retmode: 'text',
      label: 'fasta/text',
    });
    expect(resolveFetchFormat('nuccore', undefined, 'text')).toEqual({
      rettype: 'fasta',
      retmode: 'text',
      label: 'fasta/text',
    });
  });

  it('maps a PMC text request to MEDLINE', () => {
    expect(resolveFetchFormat('pmc', undefined, 'text')).toEqual({
      rettype: 'medline',
      retmode: 'text',
      label: 'medline/text',
    });
  });

  it('sends no format parameters for PMC by default', () => {
    expect(resolveFetchFormat('pmc', undefined, undefined)).toEqual({
      label: 'the database default format',
    });
  });

  it('sends no format parameters for other databases by default', () => {
    expect(resolveFetchFormat('gene', undefined, undefined)).toEqual({
      label: 'the database default format',
    });
  });

  it('sends only retmode for a text request without a database default', () => {
    expect(resolveFetchFormat('gene', undefined, 'text')).toEqual({ retmode: 'text', label: 'text' });
  });

  it('sends only retmode for xml and textual asn.1 requests without a rettype', () => {
    expect(resolveFetchFormat('gene', undefined, 'xml')).toEqual({ retmode: 'xml', label: 'xml' });
    expect(resolveFetchFormat('pubmed', undefined, 'xml')).toEqual({ retmode: 'xml', label: 'xml' });
    expect(resolveFetchFormat('gene', undefined, 'asn.1')).toEqual({
      retmode: 'asn.1',
      label: 'asn.1',
    });
  });

  it('rejects binary ASN.1 for sequence databases', () => {
    expect(() => resolveFetchFormat('nuccore', undefined, 'asn.1')).toThrow(EUtilsError);
    expect(() => resolveFetchFormat('protein', undefined, 'asn.1')).toThrow(EUtilsError);
  });

  it('treats an empty rettype as absent', () => {
    expect(resolveFetchFormat('pmc', '', 'text')).toEqual({
      rettype: 'medline',
      retmode: 'text',
      label: 'medline/text',
    });
  });
});

describe('resolveSequenceOptions', () => {
  it('passes sequence options through for sequence databases', () => {
    const options = { strand: 1, seq_start: 1, seq_stop: 100, complexity: 3 };
    expect(resolveSequenceOptions('nuccore', options)).toEqual(options);
  });

  it('returns nothing when no sequence option was supplied', () => {
    expect(resolveSequenceOptions('pubmed', {})).toEqual({});
  });

  it('rejects sequence options outside sequence databases', () => {
    expect(() => resolveSequenceOptions('pubmed', { seq_start: 1 })).toThrow(EUtilsError);
    expect(() => resolveSequenceOptions('gene', { complexity: 2 })).toThrow(EUtilsError);
  });

  it('allows strand only for nuccore and nucleotide', () => {
    expect(() => resolveSequenceOptions('protein', { strand: 1 })).toThrow(EUtilsError);
    expect(resolveSequenceOptions('nucleotide', { strand: 2 })).toEqual({ strand: 2 });
  });

  it('rejects seq_stop before seq_start and accepts equal bounds', () => {
    expect(() => resolveSequenceOptions('nuccore', { seq_start: 100, seq_stop: 50 })).toThrow(EUtilsError);
    expect(resolveSequenceOptions('nuccore', { seq_start: 5, seq_stop: 5 })).toEqual({
      seq_start: 5,
      seq_stop: 5,
    });
  });
});
