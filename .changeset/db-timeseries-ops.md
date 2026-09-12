---
"zelavis": minor
---

Aggregate a time series by its endpoints and its distribution.

`aggregate` gains `quantile`, `first`, `last`, `delta` and `rate` alongside the
`avg`, `sum`, `min`, `max` and `count` it already had. A quantile takes `p` as a
fraction from 0 to 1 -- 0.5 is the median, 0.99 the ninety-ninth percentile --
and interpolates between the two values it falls between, so the median of an
even number of points is the midpoint of the middle two rather than an arbitrary
one of the pair. A rate is the change between the window's first and last point
divided by the seconds between them.

The four endpoint operations sort by time before answering, which the folds that
were there before did not have to do. Points come back in posting order -- the
order they were written -- and that is invisible to `sum` or `max` but decides
the answer for `first`, `delta` and `rate`: a point written late for an early
instant would otherwise be taken for the end of the window. A quantile likewise
sorts, by value.

Window bounds stay closed on both sides, so `start` and `end` are included. An
empty window answers zero, as it already did. A window holding one point -- or
several sharing an instant -- spans no time, so its rate is zero rather than a
division by it. A `quantile` without a usable `p` is a defect rather than an
error, as a bad page limit already is: it is a mistake in the call, not a
property of the data.

Over HTTP the aggregate route takes `p` as well, and its validation now lists
the operations from the one place that knows them, so adding another cannot
leave the error message describing the set it used to accept.

Stated limits: these are the operations that answer with a single number, which
is what `aggregate` returns. Moving windows, histograms and interpolation answer
with a series and need a surface of their own, so they are not here. Neither are
rollups, downsampling or retention. The HTTP aggregate route still does not pass
`tags` through, though the runtime API does.
