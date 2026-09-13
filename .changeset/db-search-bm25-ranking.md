---
"zelavis": minor
---

feat(db): BM25 relevance scoring, ranking, and phrase search

Full-text search now ranks results by BM25 relevance score when no explicit `orderBy` is passed, scoring by term frequency, field token lengths, candidate inverse document frequency (IDF), and proximity boosts. Quoted phrase queries (`"quick brown"`) are verified consecutively against analyzed fields, and matching documents carry an optional numeric `score`.
