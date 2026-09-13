---
"zelavis": minor
---

Aggregate a collection without reading its documents.

A collection can declare a `MeasureDefinition`: a name and the field holding a
number. Writes keep that number in the measure lens, and `summarize` answers
`count`, `sum`, `avg`, `min`, `max`, `variance`, `stddev` and `countDistinct`
over it, with `summarizeBy` grouping the answer by a field.

The filters run first. Whatever `where`, `search`, `geometry` and `linked`
admit is resolved to a set of identifiers, and only then is the measure read --
as one dense vector indexed by identifier, so summing a million documents reads
a million doubles rather than a million payloads. Grouping reads its keys from
the ordered lens alongside the identifiers, so it does not touch the documents
either.

Only finite numbers are kept. A field that is absent, null, a string, an object
or a non-finite number has no measure posting, and such a document is not
counted -- which is why `avg` divides by the documents that carried a value
rather than by the documents that matched. A stored zero is a value and counts;
the dense vector cannot tell the two apart on its own, so presence comes from
the field's own ordered postings rather than from a zero in the vector.

Every answer carries `documents` alongside its `value`, so a caller can see what
the number was computed over instead of inferring it.

Stated limits: one measure per answer -- covariance and other two-measure
statistics need a form that names both, and are not here. Variance and standard
deviation are population, not sample. Histograms answer with a distribution
rather than a number and need their own surface. There are no materialized
aggregate projections yet, so every answer is computed when it is asked for.
