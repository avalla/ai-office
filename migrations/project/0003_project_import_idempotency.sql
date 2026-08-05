DELETE FROM project_source
WHERE local_path IS NOT NULL
  AND rowid NOT IN (
    SELECT MIN(rowid)
    FROM project_source
    WHERE local_path IS NOT NULL
    GROUP BY local_path
  );

CREATE UNIQUE INDEX project_source_local_path_unique_idx
ON project_source(local_path)
WHERE local_path IS NOT NULL;
