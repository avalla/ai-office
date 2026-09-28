# ADR-0025: AgentKnowledgeStore nativo per la conoscenza degli agenti

- **Data**: 2026-09-28
- **Stato**: accettata; adozione per slice AK-01–AK-08
- **Decisori**: AI Office maintainers
- **Tag**: conoscenza, memoria, SurrealDB, Runtime

## Contesto

CairnKeep fornisce oggi una ricerca opzionale e in sola lettura per il contesto
dei worker. La sua memoria è esterna, non autorevole e collegata al progetto
tramite una scope derivata dal `repositoryId` portabile. I PR #64–#66 hanno
valutato SurrealDB: il grafo di provenienza è utile per ricordi e decisioni,
mentre l'esperimento non dimostra la parità necessaria per usarlo come
`ProjectStorage` o autorità di esecuzione.

## Decisione

`AgentKnowledgeStore` diventa l'unico contratto applicativo canonico per
conoscenza di progetto, ricordi, decisioni, fonti e relazioni. SurrealDB ne è
l'adapter di persistenza quando la conoscenza è abilitata esplicitamente. Ogni
operazione riceve dal Runtime una scope fidata con tenant e `repositoryId`
portabile; né un modello né il percorso del checkout possono scegliere una
scope alternativa. Le letture sono limitate, ordinate in modo deterministico e
con provenienza verificabile. Assenza di risultati, backend non disponibile,
configurazione invalida, errore di query e risultato malformato restano stati
distinguibili.

SQLite e PostgreSQL conservano l'autorità operativa per progetti, task, run,
pipeline, approvazioni, governance, audit, lock, lease, fencing, coda e outbox.
I nodi di conoscenza possono riferirsi ai loro identificatori, ma non
ridefinirne lo stato. Un guasto della conoscenza non deve invalidare
l'autorità del Runtime o bloccare un run al quale la memoria fornisce solo
contesto consultivo.

La migrazione avviene in PR sequenziali: contratto, parità di lettura,
composizione, passaggio di `RunContextAssembler`, ammissione delle scritture,
import esplicito dei dati CairnKeep, deprecazione e rimozione. Non sono previsti
dual write o dual read permanenti. I valori importati mantengono l'origine
legacy e non ricevono provenienza di run inventata.

## Conseguenze

- Un solo sottosistema di conoscenza e relazioni native fra decisioni, fonti,
  run e task semplificano la composizione del contesto.
- SurrealDB aggiunge una dipendenza operativa quando la conoscenza è attiva;
  disponibilità, backup, ripristino e monitoraggio richiedono un contratto
  separato dallo storage autorevole.
- La ricerca e l'ordinamento di CairnKeep non possono essere assunti identici:
  la compatibilità del termine letterale e le differenze di ranking devono
  essere verificate e documentate prima del passaggio.
- ADR-0018 descrive il comportamento storico di CairnKeep e sarà marcato
  superato solo quando la rimozione finale sarà completata.

Questa decisione **non autorizza** SurrealDB come `ProjectStorage`,
`AgentRuntimeRepository` o fonte di autorità per alcuno stato operativo.

## Riferimenti

- [ADR-0018](ADR-0018-optional-non-authoritative-project-memory-provider.md)
- [Valutazione SurrealDB](../architecture/experiments/surrealdb-final-evaluation.md)
- [Roadmap](../development/roadmap.md)
