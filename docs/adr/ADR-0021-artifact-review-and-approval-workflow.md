# ADR-0021: Adottare un workflow generico di review e approval degli artifact

- **Data**: 2026-09-19
- **Stato**: Accepted
- **Decisori**: AI Office architecture
- **Tag**: architecture, provenance, workflow, governance

## Contesto e problema

AI Office sta estendendo il proprio Agent Pipeline Engine oltre l'esecuzione di
un singolo agent run. Il modello corrente possiede già task, pipeline/stage run,
review di governance, approvazioni di controlled action, provenance append-only
e un Runtime autorevole, ma non definisce ancora una capability unica per
produrre, verificare e approvare output in domini diversi dal software.

Un AgentRun completato non dimostra che un task sia completato; un output
prodotto non dimostra che sia approvato; una review approvata non autorizza da
sola un side effect esterno. Il modello deve conservare queste distinzioni senza
trasformare Pull Request o GitHub in concetti del core.

## Decisione

AI Office adotterà **Artifact Review & Approval Workflow** come capability
concettuale cross-domain del core di orchestrazione.

Un `Artifact` è un output verificabile associato a un task e a uno o più
AgentRun/operatori. L'Artifact può essere interno o rappresentare una risorsa
esterna e non è necessariamente un file. Ogni versione ha identità immutabile,
fingerprint stabile, metadati e provenance del produttore. Un `ReviewRequest`
seleziona la versione esatta da verificare e una `ReviewResult` conserva verdict,
findings, identità del reviewer, timestamp e fingerprint verificato.

Il fingerprint è parte dell'autorità della review: una modifica crea una nuova
versione, conserva la review precedente nell'audit trail ma la rende stale/non
current per la nuova versione. Approval e Review sono distinti: la prima è la
decisione di governance derivata da una o più review secondo una `ReviewPolicy`,
la seconda è l'esito della verifica. La policy può richiedere reviewer umani,
LLM, policy/rules, CI o sistemi esterni, con quorum e vincoli per tipo di artifact,
rischio e dominio. Un reviewer è un adapter/provider; il core non presume che
la verifica sia eseguita da un LLM.

Il lifecycle concettuale è:

```text
Task -> AgentRun -> Artifact version
     -> ReviewRequest -> ReviewResult
     -> Approval / Changes Requested / Rejection
     -> eventuale nuova AgentRun e nuova Artifact version
     -> Approved Artifact
     -> Authoritative Execution / Publish / Release
     -> Task completion
```

L'`Authoritative Execution` rimane separato e passa dai confini Runtime,
capability, connector e controlled-action già esistenti. Review e approval non
creano capability e non sostituiscono l'approvazione di una specifica azione.

## Alternative considerate

- **Pull Request come astrazione core** — rifiutata: è una specializzazione del
  dominio software. GitHub sarà un adapter che può rappresentare un
  `PullRequestArtifact`, il cui `headSha` può fungere da fingerprint naturale.
- **Riutilizzare invariato il modello M5 `ReviewRecord`** — rifiutata: M5
  governa task, requirement, milestone e ADR e non vincola l'esito alla
  versione/fingerprint di un artifact. L'infrastruttura di review/audit e gli
  actor identity possono essere riutilizzati, ma la semantica artifact-review
  deve conservare il proprio binding.
- **Considerare l'output dell'agent come completamento** — rifiutata: elimina
  review indipendente, correction loop, recovery e separazione dall'esecuzione
  esterna.

## Conseguenze

- Software engineering, manufacturing, legal, finance, operations e compliance
  possono definire artifact type, policy, reviewer ed executor senza forkare
  orchestrazione, capability o audit.
- Review history, reviewer identity, version/fingerprint e provenance devono
  essere append-only e recuperabili; replay e recovery non possono riattivare
  silenziosamente una stale approval.
- L'implementazione futura dovrà decidere aggregate, schema persistente, eventi
  e read model, riusando il lifecycle task/pipeline e l'audit esistenti invece di
  creare una seconda autorità. Questa ADR non implementa il runtime.
- Le policy possono consentire approvazione automatica a basso rischio o imporre
  human approval; nessuna policy domain-specific può indebolire i confini del
  core.

## Compatibilità

M5 governance reviews, M6 controlled-action approvals, pipeline-stage approval
gates e professional approvals restano distinti per soggetto, identità, scope e
invalidazione. Il nuovo modello li coordina quando un workflow lo richiede, ma
non li sostituisce. Task e AgentRun mantengono i lifecycle attuali; il futuro
read model può esporre `artifact_ready`, `awaiting_review` o `approved` senza
introdurre ora nuovi stati nel Task aggregate.

Vedi [domain model](../architecture/domain-model.md), [architecture overview](../architecture/overview.md),
[roadmap](../development/roadmap.md) e [professional-work verticals](../development/professional-work-verticals.md).
