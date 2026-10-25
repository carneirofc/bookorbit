# Discover view

Discover is a faceted way to browse one library: pick tags, genres, authors, series and other values to include or exclude, and every facet shows how many books each value would give you. This document describes the server contract that backs it. The user guide for the view itself is added together with the view.

The results grid does not have its own endpoint. Discover compiles its selection into an ordinary filter and pages through the existing library listing, `POST /api/v1/libraries/:id/books`. Only the facet counts are new: `POST /api/v1/libraries/:id/discover/facets`.

## API contract

### Endpoint

`POST /api/v1/libraries/:id/discover/facets`

- Authentication: a normal session or bearer token.
- Access: the same as the library listing. The caller needs at least `viewer` access to library `:id` (superusers always pass), and the library must be a books library. No extra permission is required; the endpoint only reads.
- Success: `201 Created` with a JSON body, like the other `POST` read endpoints under `/libraries/:id/books`.

### Request

```json
{
  "q": "dragon",
  "selection": {
    "terms": {
      "tag": {
        "include": ["Isekai", "Reincarnation"],
        "exclude": ["Harem"],
        "mode": "all"
      },
      "genre": { "include": ["Fantasy"], "exclude": [], "includeNone": true },
      "authorId": { "include": ["812"], "exclude": [] },
      "readStatus": { "include": ["unread"], "exclude": [] },
      "rating": { "include": [], "exclude": ["1", "2"] }
    },
    "ranges": {
      "publishedYear": { "min": 2015 },
      "addedAt": { "withinLastDays": 90 }
    }
  },
  "facets": [
    { "key": "tag", "limit": 30 },
    { "key": "genre", "search": "fan", "sort": "alpha" },
    { "key": "readStatus" },
    { "key": "publishedYear" }
  ]
}
```

| Field       | Type                 | Notes                                                                                                                                                                     |
| ----------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `selection` | object, optional     | The current Discover selection. Defaults to `{}` (nothing selected).                                                                                                      |
| `q`         | string, optional     | Quick search, up to 200 characters. Same matching as `q` on the library listing: title, subtitle, authors, series and narrators.                                          |
| `facets`    | array, 0 to 12 items | Which facets to count. Keys must be unique. An empty list returns only `total` and `libraryTotal`, which is how a client asks "how many books would this selection show". |

Every object is strict: an unknown field anywhere in the body is rejected with `400`, the same as the rest of the API.

#### Term facets

`selection.terms` holds one entry per term facet:

| Key          | Values                                                                                      | Match modes            | "(none)" bucket |
| ------------ | ------------------------------------------------------------------------------------------- | ---------------------- | --------------- |
| `tag`        | Tag names, exact and case-sensitive                                                         | `all` (default), `any` | Yes             |
| `genre`      | Genre names, exact and case-sensitive                                                       | `any` (default), `all` | Yes             |
| `authorId`   | Author ids as decimal strings, for example `"812"`                                          | `any` (default), `all` | Yes             |
| `series`     | Series names, exact                                                                         | `any`                  | Yes             |
| `language`   | `book_metadata.language` values, exact (for example `en`)                                   | `any`                  | Yes             |
| `format`     | `epub`, `pdf`, `cbz`, ... and `epub:readalong` for EPUBs with a read-along overlay          | `any`                  | No              |
| `publisher`  | Publisher names, exact                                                                      | `any`                  | Yes             |
| `readStatus` | `unread`, `want_to_read`, `reading`, `on_hold`, `rereading`, `read`, `skimmed`, `abandoned` | `any`                  | No              |
| `rating`     | The caller's own rating, `"1"` to `"5"`                                                     | `any`                  | Yes (unrated)   |

Each entry is `{ include, exclude, mode?, includeNone?, excludeNone? }`:

- `include` / `exclude`: up to 100 values each, no duplicates, and no value in both lists. At most 200 values across the whole selection.
- `mode`: how included values combine. `any` matches books with at least one of them, `all` matches books with every one of them. `all` is only accepted for `tag`, `genre` and `authorId`, the facets where one book holds several values; the other facets reject it with `400`.
- `includeNone`: also match books with no value for the facet (no tags, no series, unrated, ...). In `any` mode it is ORed with the included values; in `all` mode the result is "has all of these, or has none".
- `excludeNone`: drop books with no value for the facet. `includeNone` and `excludeNone` cannot both be set, and neither is accepted on `format` or `readStatus`.
- Excluded values always remove books, whatever the mode.
- `unread` also covers books the caller never opened, matching the library listing. Read status and rating are always the caller's own.

Authors are matched by id through the `authorId` filter field. The older `author` field matches a name substring ("Ann" also finds "Joanne"), so it cannot give counts that equal the results; it is unchanged.

#### Range facets

`selection.ranges` holds `publishedYear`, `pageCount` and `addedAt`:

| Key             | Selection                                                                        |
| --------------- | -------------------------------------------------------------------------------- |
| `publishedYear` | `{ min?, max? }`, integers from -9999 to 9999                                    |
| `pageCount`     | `{ min?, max? }`, integers from 0 to 1,000,000                                   |
| `addedAt`       | `{ min?, max? }` as `YYYY-MM-DD`, or `{ withinLastDays }` (1 to 36500), not both |

Both ends are inclusive and either may be left out. `addedAt` dates are whole UTC days, so `{ "min": "2024-03-01", "max": "2024-03-31" }` covers all of March 2024 in UTC. `min` must not exceed `max`.

#### Facet requests

Each item in `facets` is `{ key, limit?, search?, sort? }`:

- `key`: any term or range facet key.
- `limit`: term facets only, 1 to 500, default 30.
- `search`: term facets only, up to 200 characters. Keeps values whose label contains the text, ignoring case and accents.
- `sort`: term facets only. `count` (default) sorts by book count, highest first, then by label; `alpha` sorts by label.

`limit`, `search` and `sort` on a range facet are rejected with `400`.

### Response

```json
{
  "total": 412,
  "libraryTotal": 8731,
  "facets": {
    "tag": {
      "kind": "term",
      "key": "tag",
      "values": [
        { "value": "Overpowered MC", "label": "Overpowered MC", "count": 188 }
      ],
      "selected": [
        { "value": "Isekai", "label": "Isekai", "count": 412 },
        { "value": "Reincarnation", "label": "Reincarnation", "count": 412 },
        { "value": "Harem", "label": "Harem", "count": 0 }
      ],
      "noneCount": 0,
      "truncated": true
    },
    "publishedYear": {
      "kind": "range",
      "key": "publishedYear",
      "min": 1998,
      "max": 2026,
      "buckets": [{ "from": 1998, "to": 1999, "count": 12 }],
      "noneCount": 31
    }
  }
}
```

| Field          | Meaning                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------- |
| `total`        | Books matching the whole selection and `q`. Equals `total` from the listing with the same filter. |
| `libraryTotal` | Books visible in the library with no selection and no `q`.                                        |
| `facets`       | One entry per requested facet, keyed by facet key.                                                |

A term facet result has:

- `values`: the top values by the requested sort, leaving out every value that is already included or excluded. Only values with at least one book appear.
- `selected`: every included value, then every excluded value, in request order, with its count. A value that no longer exists (a renamed tag, a deleted author) is still echoed with `count: 0` and its raw value as the label, so the client can show and remove it. For `authorId`, `label` is the author's name.
- `noneCount`: books with no value for the facet; always `0` for `format` and `readStatus`.
- `truncated`: `true` when more values matched than `limit` let through.

A range facet result has:

- `min` / `max`: the smallest and largest value, or `null` when no book has one. For `addedAt` these are the first day of the earliest month and the last day of the latest month, as `YYYY-MM-DD` in UTC.
- `buckets`: up to 20 contiguous buckets from `min` to `max`, both ends inclusive, including empty ones. Numeric facets use equal integer widths (one bucket per year when the span is 20 years or less); `addedAt` uses whole UTC months.
- `noneCount`: books with no value (`addedAt` is never empty).

Labels are raw values. Translating read statuses, formats or language codes is up to the client.

### Count semantics

Every count is the number of books the library listing would return for a related filter, computed with the same filter compiler, access scope, content filters and "still processing" exclusion as the listing:

- **ANY facet with something included** (genres by default): counted without its own includes, but with its excludes and every other facet. Each value shows how many books it covers among everything else you picked, which is what selecting it would add.
- **ALL facet** (tags by default), **or any facet with nothing included**: counted under the full selection. In ALL mode this is a drill-down: "books with every selected tag and also this one".
- **Range facet**: summarized without its own range, so the histogram shows what is reachable.
- **Excludes** always apply, including to their own facet, so an excluded value counts `0`.
- **`noneCount`**: the facet's count filter plus "has no value".

The `discover-facets` e2e suite asserts each of these equalities against `POST /libraries/:id/books`.

### Getting the results

Compile the selection with `compileDiscoverFilter` from `@bookorbit/types` and send it to the existing listing:

```ts
import { compileDiscoverFilter } from "@bookorbit/types";

const body = {
  filter: compileDiscoverFilter(selection),
  q,
  sort: [{ field: "addedAt", dir: "desc" }],
  pagination: { page: 0, size: 100 },
  collapseSeries: false,
};
await fetch(`/api/v1/libraries/${libraryId}/books`, {
  method: "POST",
  body: JSON.stringify(body),
  headers,
});
```

The compiler returns `undefined` for an empty selection. Its output is an ordinary `GroupRule` (value lists are split into rules of at most 20 values, the validator's limit), so it can also be saved as a smart scope. `compileDiscoverFilter(selection, { omitFacet, omitIncludesOnly })` produces the per-facet count filters described above.

### Errors

| Status | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400`  | Invalid body: unknown field or facet, a limit exceeded, `mode: "all"` on a single-valued facet, a value both included and excluded, a none bucket on `format` or `readStatus`, an unknown `format` / `readStatus` / `rating` value, a non-numeric author id, an inverted range, duplicate facet keys, or `limit` / `search` / `sort` on a range facet. The message names the first offending field, for example `Invalid discover facets request: selection.terms.language.mode: Match mode 'all' is not available for language`. |
| `400`  | `:id` is not a positive integer (`Missing or invalid libraryId`), or the library is not a books library (`This endpoint requires a books library`).                                                                                                                                                                                                                                                                                                                                                                               |
| `401`  | Not signed in.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `403`  | No access to the library (`No library access`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `404`  | The library does not exist (`Library not found`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### Example

```sh
curl -sS -X POST "https://bookorbit.example/api/v1/libraries/3/discover/facets" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "selection": {
      "terms": {
        "tag": { "include": ["Isekai"], "exclude": ["Harem"] },
        "genre": { "include": ["Fantasy", "Science Fiction"], "exclude": [] }
      },
      "ranges": { "publishedYear": { "min": 2015 } }
    },
    "facets": [{ "key": "tag" }, { "key": "genre" }, { "key": "readStatus" }, { "key": "publishedYear" }]
  }'
```

## Appendix: facet query benchmark

Measured on 2026-10-25 with the opt-in benchmark `server/test/discover-facets-benchmark.e2e-spec.ts`, on a 16-core development machine against the dev-compose PostgreSQL. The numbers are wall-clock times of the whole request through the Nest app (`app.inject`, no network), as the superuser, so content filters do not apply. Treat them as relative: they depend on hardware and on how the synthetic data is shaped.

Seed (generated with `generate_series`, nothing committed): one library; 2,000 tags with 8 to 16 per book, skewed so a few tags are on many books; 40 genres with 1 to 3 per book; one author per 4 books, with 1 or 2 authors per book; one series per 10 books, holding 60% of the books; 8 languages, 200 publishers, 90% of books with a year, 85% with a page count, added dates over about four years; 30% of books with a read status and 20% with a rating for the measuring user.

Selections:

| Active facets | Selection                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------ |
| 0             | Nothing selected                                                                                                   |
| 1             | One tag (ALL)                                                                                                      |
| 3             | Two tags (ALL), two genres (ANY), read status `unread`                                                             |
| 6             | One tag included and one excluded, two genres, `unread`, language not `fr`, format `epub` or `pdf`, year from 1990 |

"3 (default panels)" requests `tag`, `genre` and `readStatus`, the panels Discover expands by default. "12 (all)" requests every facet. The last column is the `EXPLAIN (ANALYZE, BUFFERS)` execution time of the three slowest facet queries in one request (the `db.execute` queries; the `count(*)` totals and none buckets are not in it).

### 5,000 books (58,864 tag links), 15 timed runs per row

| Active facets | Facets requested   | p50 ms | p95 ms | Slowest facet queries (ms) |
| ------------- | ------------------ | ------ | ------ | -------------------------- |
| 0             | 3 (default panels) | 37     | 53     | 29.8, 3.9, 3.4             |
| 0             | 12 (all)           | 58     | 69     | 28.2, 13.3, 9.8            |
| 1             | 3 (default panels) | 34     | 44     | 16.9, 13.3, 7.9            |
| 1             | 12 (all)           | 57     | 62     | 17.7, 14.8, 10.7           |
| 3             | 3 (default panels) | 40     | 51     | 25.2, 23.8, 16.5           |
| 3             | 12 (all)           | 115    | 134    | 27.4, 25.9, 24.9           |
| 6             | 3 (default panels) | 28     | 35     | 17.3, 8.7, 8.6             |
| 6             | 12 (all)           | 78     | 86     | 18.8, 17.4, 15.3           |

Every case is well inside the 300 ms p95 target, so there is no index migration and no facet cache.

### 50,000 books (588,320 tag links), 7 timed runs per row

| Active facets | Facets requested   | p50 ms | p95 ms | Slowest facet queries (ms) |
| ------------- | ------------------ | ------ | ------ | -------------------------- |
| 0             | 3 (default panels) | 108    | 112    | 120.5, 46.7, 24.1          |
| 0             | 12 (all)           | 279    | 318    | 137.9, 129.9, 120.9        |
| 1             | 3 (default panels) | 229    | 332    | 251.2, 244.5, 172.2        |
| 1             | 12 (all)           | 593    | 616    | 254.0, 234.5, 166.1        |
| 3             | 3 (default panels) | 280    | 287    | 240.0, 226.3, 71.0         |
| 3             | 12 (all)           | 969    | 1030   | 296.7, 257.0, 256.8        |
| 6             | 3 (default panels) | 312    | 389    | 295.4, 130.1, 123.2        |
| 6             | 12 (all)           | 859    | 884    | 283.9, 253.9, 236.1        |

At 50k the default panels stay around 0.1 to 0.4 s, while all twelve facets take up to about 1 s. Each facet query costs roughly 120 to 300 ms here and at most three facets run at once, so opening every panel scales with the number of panels. This is why the client should only request expanded facets.

The first 50k run found one pathological plan: the tag list for the 3-facet selection took 1.8 s, because Postgres underestimated the matched set and drove the join from a sequential scan of `tags`, probing `book_tags` 1.3 million times. Relation facets now count the matched books' links per tag, genre or author in a grouped subquery and join the names afterwards (series collect their links behind `OFFSET 0`), which brought that query to about 240 ms and that case from 1.7 s to 0.29 s p50 without an index.

To reproduce, run it alone (the invariant suite in the same run can time out while a 50k seed is running):

```sh
DISCOVER_BENCH_BOOKS=5000 pnpm run e2e:run -- discover-facets test/discover-facets-benchmark.e2e-spec.ts --no-file-parallelism
DISCOVER_BENCH_BOOKS=50000 DISCOVER_BENCH_RUNS=7 pnpm run e2e:run -- discover-facets test/discover-facets-benchmark.e2e-spec.ts --no-file-parallelism
```

`DISCOVER_BENCH_PLAN=<ms>` also prints the SQL and plan of every facet query slower than that.
