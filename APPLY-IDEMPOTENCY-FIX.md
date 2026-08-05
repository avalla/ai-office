# Applicazione della correzione

Copia il contenuto di questo ZIP nella root del repository `ai-office`,
sovrascrivendo i file esistenti.

Poi esegui:

```bash
bun run typecheck
bun run test
bun run cli -- project:import .
bun run cli -- project:import .
```

La seconda esecuzione deve mostrare:

```text
Project already imported: <stesso-id>
```

La migration `0003_project_import_idempotency.sql` crea un indice univoco sul
percorso locale. La ricerca mantiene compatibilità con i due import già effettuati:
se `project_source` non è ancora popolata, recupera il progetto più vecchio tramite
il profilo `repository/root_path`.

I vecchi record di progetto duplicati non vengono eliminati automaticamente,
per evitare di cancellare dati senza conferma. Da questo momento non ne verranno
creati di nuovi per lo stesso percorso canonico.
