# Dynamic General-Agent Behavior Plan

## Purpose

Dokumen ini adalah report + plan baru untuk mengubah perilaku agent saat ini agar lebih mirip upstream:

- agent umum membaca aturan workspace
- memahami maksud user secara natural
- lalu **memilih sendiri** apakah harus:
  - mengedit `AGENTS.md`
  - mengedit `BOOT.md`
  - mengedit `IDENTITY.md`
  - mengedit `SOUL.md`
  - mengedit `TOOLS.md`
  - mengedit `USER.md`
  - mengedit `HEARTBEAT.md`
  - menyelesaikan atau menghapus `BOOTSTRAP.md`
  - menulis `MEMORY.md` atau `memory/YYYY-MM-DD.md`
  - mengedit workspace `skills/` bila itu skill lokal yang menjadi sumber perilaku
  - menulis canonical memory
  - menulis knowledge/docs canonically
  - mengandalkan history retrieval saat intent-nya memang history
  - mengubah config/runtime canonical yang relevan
  - memanggil tool cron
  - memanggil webhook/action tool
  - atau hanya menjawab

Targetnya bukan “semua diserahkan ke improvisasi model”, tetapi:

- **routing intent tidak hardcode per kalimat**
- **eksekusi tetap aman, auditable, dan canonical**
- behavior terasa dinamis seperti upstream
- tetap kompatibel dengan memory backend `memory-langchain`

Catatan:

- File ini sengaja dibuat sebagai Markdown baru di root repo/workspace.
- File ini bukan implementasi.
- File ini tidak otomatis bootstrap-injected pada sesi berikutnya kecuali dibaca eksplisit.
- File ini **melengkapi**, bukan menggantikan, `REMINDER_AUTOMATION_HANDOVER.md`.
- Semua jaminan reminder/cron yang sudah dikunci di handover lama tetap dianggap wajib.

---

## Executive Summary

Hasil audit menunjukkan bahwa upstream terasa “dinamis” bukan karena memiliki parser khusus untuk kalimat seperti:

- `nama anda sekarang adalah zoro`
- `saya bernama bevan`
- `tolong ingatkan saya nanti`

Yang terjadi di upstream lebih dekat ke pola ini:

1. workspace bootstrap files di-inject ke context
2. agent diberi tahu bahwa identitas/profilnya hidup di file tertentu
3. agent punya tool umum untuk membaca/mengedit workspace
4. agent memutuskan sendiri tindakan paling tepat

Akibatnya, upstream bisa terlihat “otomatis mengganti dirinya sendiri”, padahal itu biasanya adalah hasil:

- model umum membaca aturan workspace
- lalu memilih mengedit `IDENTITY.md` atau config

bukan hasil dari hardcoded feature “jika kalimat A maka rename”.

Fork ini saat ini sudah lebih kuat di beberapa jalur deterministic, tetapi masih hybrid:

- sebagian behavior sudah semantic/canonical
- sebagian masih cue/regex-driven
- sebagian masih terlalu diarahkan ke handler khusus

Kalau target produk adalah “dinamis seperti upstream”, maka arsitektur berikut yang dibutuhkan:

- gunakan classifier/domain arbiter yang **broad** dan **semantic**
- biarkan general agent menangani mutasi workspace/profile/tool selection
- tetap pakai tool/canonical store untuk eksekusi final
- hindari hardcoded sentence matcher sebagai fondasi utama

---

## Proven Audit Findings

Semua poin di bawah ini sudah didasarkan pada audit kode yang bisa diverifikasi.

### 1. Upstream memang menaruh identitas agent di workspace files

Bukti:

- `docs/reference/templates/AGENTS.dev.md:14-16`
  - agent diberi tahu bahwa identitasnya hidup di `IDENTITY.md`
  - profil user hidup di `USER.md`
- `docs/reference/templates/BOOTSTRAP.md:31-36`
  - setelah agent tahu siapa dirinya dan siapa user, ia diarahkan untuk mengupdate:
    - `IDENTITY.md`
    - `USER.md`

Makna:

- upstream memang menanamkan pola “identity/profile are editable workspace artifacts”
- jadi wajar agent umum bisa terlihat seperti “mengganti identitasnya sendiri”

### 2. Workspace bootstrap files memang di-inject ke context model

Bukti:

- `docs/concepts/context.md:99-113`
  - OpenClaw meng-inject:
    - `AGENTS.md`
    - `SOUL.md`
    - `TOOLS.md`
    - `IDENTITY.md`
    - `USER.md`
    - `HEARTBEAT.md`
    - `BOOTSTRAP.md`

Makna:

- agent upstream tidak buta terhadap workspace bootstrap files
- jadi ia memang bisa membaca aturan bahwa “identitas saya ada di `IDENTITY.md`”

### 3. Scope workspace yang terlihat oleh agent upstream lebih luas dari hanya identity/profile

Bukti:

- `docs/concepts/agent-workspace.md:68-101`
  - workspace standar juga mencakup:
    - `AGENTS.md`
    - `BOOT.md`
    - `TOOLS.md`
    - `HEARTBEAT.md`
    - `BOOTSTRAP.md`
    - `MEMORY.md`
    - `memory/YYYY-MM-DD.md`
    - `skills/`
- `docs/reference/templates/AGENTS.md:50-52`
  - saat agent belajar hal baru atau membuat kesalahan, ia diarahkan untuk mengupdate:
    - `AGENTS.md`
    - `TOOLS.md`
    - relevant skill
- `docs/reference/templates/AGENTS.md:139-142`
  - `HEARTBEAT.md` memang secara eksplisit boleh diedit agent
- `docs/concepts/system-prompt.md:55-61`
  - `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, dan `BOOTSTRAP.md` semua ikut injected ke context

Makna:

- scope dinamis upstream tidak berhenti di `IDENTITY.md`, `USER.md`, dan `SOUL.md`
- agent umum juga punya alasan untuk memelihara:
  - aturan operasional (`AGENTS.md`)
  - startup action surface (`BOOT.md`)
  - catatan tool/convention (`TOOLS.md`)
  - checklist heartbeat (`HEARTBEAT.md`)
  - lifecycle bootstrap (`BOOTSTRAP.md`)
  - curated memory (`MEMORY.md`, `memory/YYYY-MM-DD.md`)
  - workspace-local skills (`skills/`)

### 4. Scope durable state lain yang belum boleh dilupakan

Bukti:

- `docs/reference/templates/AGENTS.md:50-52`
  - lesson learned dapat diarahkan ke `AGENTS.md`, `TOOLS.md`, atau relevant skill
- `docs/gateway/heartbeat.md:20-25`
  - heartbeat adalah surface periodik tersendiri, bukan sekadar cron
- `docs/automation/hooks.md:694-707`
  - `BOOT.md` dibaca pada startup oleh hook terkait dan bisa menjalankan action agent
- `docs/concepts/memory.md:21-52`
  - `MEMORY.md` dan `memory/YYYY-MM-DD.md` adalah surface memory workspace yang nyata
- `src/memory/docs-kb-store.ts:37-45`
  - docs/knowledge punya store durable tersendiri
- `extensions/memory-core/index.ts:11-24`
  - history retrieval adalah domain retrieval tersendiri
- `docs/cli/config.md:10-21`
  - runtime/config mutation di `~/.openclaw/openclaw.json` adalah surface resmi

Makna:

- dynamic general-agent plan juga harus mempertimbangkan domain berikut:
  - startup behavior (`BOOT.md`)
  - heartbeat behavior (`HEARTBEAT.md`)
  - workspace memory (`MEMORY.md`, daily memory)
  - docs/knowledge store
  - history retrieval
  - config/runtime mutation
  - workspace-local skill mutation atau penciptaan skill baru

### 5. Jalur resmi ubah identitas tetap lewat config/tooling, bukan sentence-specific feature

Bukti:

- `docs/cli/agents.md:128-144`
  - `openclaw agents set-identity` adalah jalur resmi update identity
- `src/commands/agents.commands.identity.ts:144-198`
  - command ini menulis ke `agents.list[].identity`

Makna:

- upstream tidak punya bukti adanya hardcoded feature khusus untuk sentence “nama anda sekarang adalah X”
- yang ada adalah:
  - workspace conventions
  - general agent behavior
  - explicit identity tooling

### 6. `memory-langchain` tidak menghalangi behavior dinamis model-driven

Bukti:

- `docs/concepts/context-engine.md:245-247`
  - memory plugins dan context engines adalah concern yang berbeda
- `extensions/memory-langchain/src/manager.ts:1-120`
  - plugin ini fokus pada chunking, embeddings, vector retrieval, dan indexing

Makna:

- `memory-langchain` bukan penghalang utama untuk membuat agent terasa dinamis seperti upstream
- yang perlu diubah justru:
  - front-door routing
  - workspace mutation policy
  - canonical sync rules

### 7. Pemilihan “masuk RAG atau tidak” saat ini masih belum benar-benar dinamis

Bukti:

- `docs/concepts/system-prompt.md:53-71`
  - `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md`, dan `MEMORY.md` masuk langsung ke context
  - `memory/YYYY-MM-DD.md` justru tidak diinject otomatis dan baru diambil on-demand via `memory_search` / `memory_get`
- `src/memory/domain.ts:3-23`
  - domain retrieval dipetakan eksplisit:
    - `user_memory`
    - `docs_kb`
    - `history`
- `src/auto-reply/memory-recall.ts:28-58`
  - router retrieval masih memakai banyak regex/cue untuk mengenali query `history`, `docs_kb`, atau `user_memory`
- `src/auto-reply/memory-recall.ts:138-179`
  - pemilihan domain recall saat ini masih terutama ditentukan oleh `detectRetrievalIntent(...)`
- `src/auto-reply/memory-save.ts:35-55`
  - save docs/knowledge juga masih diawali token/cue khusus
- `src/auto-reply/memory-save.ts:168-193`
  - owner-profile save masih lewat gating semantic/cue, belum lewat general planner tunggal

Makna:

- saat ini agent belum sepenuhnya “tahu secara dinamis” mana yang:
  - sudah ada di context
  - harus dibaca dari canonical store
  - harus dicari lewat `user_memory`
  - harus dicari lewat `docs_kb`
  - harus dicari lewat `history`
- keputusan itu masih banyak dipandu oleh router/heuristic, bukan oleh planner umum yang benar-benar semantic

---

## Root Cause: Kenapa Fork Ini Belum Terasa Se-Dinamis Upstream

### 1. Terlalu banyak front-door special handlers

Fork ini sudah menambah beberapa lapisan deterministic seperti:

- `src/auto-reply/self-facts.ts`
- `src/auto-reply/scheduling-intent.ts`
- `src/auto-reply/memory-save.ts`
- `src/auto-reply/memory-recall.ts`

Itu berguna untuk robustness, tetapi efek sampingnya:

- jalur model umum menjadi lebih sempit
- bentuk kalimat tertentu masuk handler khusus
- paraphrase berbeda kadang bisa berakhir di handler berbeda

### 2. Sebagian routing masih cue/regex-based

Walau sudah ada perbaikan semantic, sebagian besar decision layer masih campuran:

- semantic concepts
- cue tokens
- regex
- exact-ish branch behavior

Akibatnya:

- maksud sama dengan phrasing berbeda masih bisa menghasilkan:
  - jawaban berbeda
  - tool path berbeda
  - atau fallback ke model umum

### 3. Workspace mutation belum menjadi domain eksplisit

Saat ini belum ada domain yang jelas untuk hal-hal seperti:

- `nama anda sekarang adalah zoro`
- `ubah gaya bicara anda jadi lebih santai`
- `simpan bahwa tugas utama anda adalah ...`
- `nama saya sekarang ...`

Padahal upstream effectively memperlakukan ini sebagai:

- workspace/profile mutation request

bukan sekadar QA atau memory note biasa.

### 4. Canonical surfaces masih tersebar

Saat ini informasi bisa hidup di banyak tempat:

- `AGENTS.md`
- `BOOT.md`
- `IDENTITY.md`
- `TOOLS.md`
- `USER.md`
- `SOUL.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md`
- `MEMORY.md`
- `memory/YYYY-MM-DD.md`
- workspace-local `skills/`
- canonical owner facts
- docs/knowledge canonical store
- history retrieval surface
- `agents.list[].identity`
- config/runtime surfaces lain yang user-facing
- memory backend (`memory-langchain`)

Tanpa contract yang jelas, agent bisa terasa tidak konsisten.

---

## Target Product Behavior

Target akhirnya:

- user bicara natural
- agent memahami domain intent secara semantic
- agent memilih surface dan tool yang benar
- agent mengubah state yang tepat
- jawaban dan state berikutnya konsisten

### Contoh target behavior

#### A. Assistant self-mutation

Input:

- `nama anda sekarang adalah zoro`
- `mulai sekarang saya panggil anda zoro`
- `ubah identitas anda jadi zoro, tetap formal`

Target behavior:

- agent memahami ini sebagai **assistant identity mutation**
- agent memutuskan surface canonical mana yang harus diubah
- agent mengubah durable state secara terkontrol
- `siapa anda?` sesudahnya harus konsisten

#### A2. Assistant operating-rules mutation

Input:

- `mulai sekarang jangan terlalu verbose`
- `kalau kerja di repo ini selalu prioritaskan bun`
- `ingat, kalau ada error deploy cek service A dulu`

Target behavior:

- agent memahami ini sebagai **operating rule or tool convention mutation**
- agent memilih apakah harus mengupdate:
  - `AGENTS.md`
  - `TOOLS.md`
  - workspace-local `skills/`
- perubahan itu durable dan bisa memengaruhi turn berikutnya

#### A3. Startup or boot behavior mutation

Input:

- `setiap gateway hidup, cek service ini dulu`
- `tambahkan startup checklist sebelum anda mulai`

Target behavior:

- agent memahami ini sebagai **startup behavior mutation**
- `BOOT.md` atau surface startup yang setara diperbarui
- ini dibedakan dari heartbeat dan dibedakan dari cron

#### B. User-profile mutation

Input:

- `nama saya bevan`
- `panggil saya van`
- `saya alergi udang`

Target behavior:

- agent memahami ini sebagai **owner profile mutation**
- canonical owner facts diperbarui
- `siapa saya?` dan recall terkait tetap konsisten

#### C. Reminder / automation

Input:

- `ingatkan saya 2 menit lagi`
- `tolong ping saya nanti`
- `setiap hari jam 2 malam nyalakan lampu kamar mandi lewat webhook ini`

Target behavior:

- agent memahami intent dan slot secara semantic
- lalu memilih tool terstruktur yang tepat:
  - cron
  - action payload
  - notify target

#### D. Heartbeat / periodic operating-state mutation

Input:

- `untuk heartbeat, cek inbox dan calendar saja`
- `tambahkan checklist heartbeat untuk cek error deploy`

Target behavior:

- agent memahami ini sebagai **heartbeat policy mutation**
- `HEARTBEAT.md` atau surface periodik terkait diperbarui
- tidak salah dipaksa menjadi cron kalau kebutuhan sebenarnya adalah heartbeat checklist

#### E. Persona / soul mutation

Input:

- `mulai sekarang jawab singkat`
- `anda harus lebih formal`
- `jangan terlalu banyak emoji`

Target behavior:

- agent memahami ini sebagai **behavior or persona mutation**
- update diarahkan ke surface yang tepat, misalnya:
  - `SOUL.md`
  - config tertentu
  - stable instruction store

#### F. Bootstrap lifecycle mutation

Input:

- `selesaikan bootstrap anda`
- `catat nama anda di identity lalu hapus bootstrap`

Target behavior:

- agent memahami ini sebagai **bootstrap lifecycle**
- mengupdate file bootstrap yang relevan
- menghapus atau menandai `BOOTSTRAP.md` selesai bila ritual sudah complete

#### G. Knowledge or history handling

Input:

- `simpan dokumen ini sebagai knowledge`
- `cari lagi percakapan saya kemarin soal deploy`

Target behavior:

- agent memahami perbedaan antara:
  - canonical knowledge/docs save
  - history recall
  - owner profile mutation
  - generic memory note
- surface yang dipilih harus tepat dan tidak bercampur

#### H. Retrieval strategy selection

Input:

- `siapa saya?`
- `apa yang tadi saya bilang soal deploy?`
- `cari docs OpenClaw tentang gateway token`
- `apa yang ada di memory saya tentang editor favorit?`

Target behavior:

- agent memahami kapan:
  - cukup jawab dari context yang sudah diinject
  - harus baca canonical store langsung
  - harus memanggil `user_memory`
  - harus memanggil `docs_kb`
  - harus memanggil `history`
- agent juga tahu kapan **tidak perlu** memanggil RAG karena jawabannya sudah ada di surface yang lebih langsung dan canonical

---

## Architecture Principles

### 1. General agent first, not sentence matcher first

Jangan lagi membuat fondasi dengan logika:

- jika kalimat mengandung X maka handler A
- jika frasa Y maka handler B

Fondasi yang benar:

- broad domain classification
- semantic slot extraction
- action planning by general agent

### 2. Deterministic execution, dynamic planning

Yang dinamis:

- pemahaman intent
- pemilihan surface
- pemilihan tool
- pemilihan strategi retrieval

Yang tetap terstruktur:

- write ke config
- write ke markdown workspace
- cron add/update/remove
- action webhook
- canonical memory write
- domain recall yang tepat saat retrieval memang dibutuhkan

Jadi targetnya bukan “100% model improvisation”, melainkan:

- **dynamic planning**
- **deterministic durable execution**

### 3. Canonical surfaces harus jelas

Setiap domain harus punya surface utama:

- assistant identity
  - primary: `agents.list[].identity`
  - mirrored human-readable workspace file: `IDENTITY.md`
- assistant operating rules
  - primary: `AGENTS.md`
- startup behavior
  - primary: `BOOT.md`
- tool and local environment notes
  - primary: `TOOLS.md`
- owner profile
  - primary: canonical owner facts
  - mirrored human-readable workspace file: `USER.md`
- assistant behavior/persona
  - primary: `SOUL.md`
- heartbeat operating checklist
  - primary: `HEARTBEAT.md`
- bootstrap lifecycle
  - primary: `BOOTSTRAP.md`
- curated long-term workspace memory
  - primary: `MEMORY.md` plus `memory/YYYY-MM-DD.md`
- workspace-local reusable behavior
  - primary: `skills/`
- knowledge/docs memory
  - primary: docs/knowledge canonical store
- history recall
  - primary: history retrieval surfaces
- operational memory/search
  - indexed via `memory-langchain`

### 4. LangChain stays memory-only, not behavior-router

`memory-langchain` tetap dipakai untuk:

- retrieval
- indexing
- semantic recall

Tetapi jangan dibebani menjadi:

- identity source of truth
- persona mutation engine
- runtime action planner
- startup/heartbeat policy store

---

## Proposed Architecture

## A. Replace many narrow handlers with a Dynamic Workspace Mutation domain

Tambahkan domain intent baru:

- `assistant_workspace_mutation`

Domain ini menangani request seperti:

- rename assistant
- change assistant vibe
- update assistant preferences/rules
- update durable user-facing identity

Output domain ini bukan jawaban final, tetapi action plan typed:

- `targetSurface`
  - `agent_identity`
  - `agent_rules`
  - `agent_boot`
  - `agent_soul`
  - `agent_tools_notes`
  - `runtime_config`
  - `owner_profile`
  - `owner_preference`
  - `heartbeat_checklist`
  - `bootstrap_lifecycle`
  - `workspace_memory`
  - `workspace_skill`
  - `knowledge_store`
  - `history_recall`
- `mutationType`
  - `set`
  - `append`
  - `replace`
  - `remove`
- `proposedChanges`
- `requiresConfirmation`

## B. Add a Workspace Surface Resolver

Buat resolver tunggal yang memetakan mutation plan ke surface nyata:

- `agent_identity`
  - update `agents.list[].identity`
  - sync `IDENTITY.md`
- `agent_rules`
  - update `AGENTS.md`
- `agent_boot`
  - update `BOOT.md`
- `agent_tools_notes`
  - update `TOOLS.md`
- `runtime_config`
  - update config/runtime canonical surface bila mutasi memang sifatnya runtime
- `owner_profile`
  - update canonical owner facts
  - sync `USER.md`
- `agent_soul`
  - update `SOUL.md`
- `heartbeat_checklist`
  - update `HEARTBEAT.md`
- `bootstrap_lifecycle`
  - update or remove `BOOTSTRAP.md`
- `workspace_memory`
  - update `MEMORY.md` or `memory/YYYY-MM-DD.md`
- `workspace_skill`
  - update relevant file under `skills/`
- `knowledge_store`
  - update docs/knowledge canonical store
- `history_recall`
  - call history retrieval path instead of mutating the wrong surface

Resolver ini harus:

- aware terhadap canonical primary store
- aware terhadap mirrored markdown file
- idempotent
- auditable
- aware terhadap auth policy
- aware terhadap route/channel constraints bila mutasi memengaruhi outbound behavior

## C. Narrow deterministic handlers to high-risk or transactional domains only

Handler deterministic tetap dipertahankan untuk domain seperti:

- cron CRUD
- webhook action
- SSRF policy
- high-risk command execution

Tetapi untuk domain identity/profile/persona mutation:

- jangan hardcode per kalimat
- cukup broad intent classification
- biarkan general agent memilih action plan

## D. Preserve transactional guarantees from the reminder handover

Dynamic planning **tidak boleh** menghapus atau melemahkan jaminan yang sudah terkunci di `REMINDER_AUTOMATION_HANDOVER.md`.

Hal-hal berikut tetap wajib dipertahankan:

- route fidelity untuk `same_chat`, `configured_channel`, dan thread/topic
- fail-fast bila route/channel yang diminta tidak tersedia
- pemisahan `actionTarget` vs `notifyTarget`
- device action tidak dimodelkan sebagai `delivery.mode = "webhook"`
- cron management natural via chat:
  - list
  - update
  - remove
  - follow-up mutation
- parse URL/ISO/natural-time tanpa merusak input
- recurring reminder tidak salah jatuh ke monitoring
- reminder final yang delivered tetap bersih
- owner-profile read/write auth policy tetap jelas
- provenance tetap audit-only
- self/runtime replies tetap canonical
- `docs_kb` / `history` / `memory` tetap dibedakan secara jujur
- SSRF private/LAN tetap safe-by-default

## E. Reconcile workspace files with canonical stores

Untuk menghindari drift:

- `agents.list[].identity` adalah source of truth runtime
- `IDENTITY.md` adalah mirrored human-readable representation
- canonical owner facts adalah source of truth user profile
- `USER.md` adalah mirrored human-readable representation

Setiap write harus:

1. update primary store
2. sync mirror file
3. queue reindex untuk `memory-langchain` bila relevan
4. jaga invariant transactional yang sudah terbukti live untuk reminder/automation

---

## Why This Still Works With LangChain

Behavior ini tetap cocok dengan `memory-langchain` karena:

1. LangChain plugin hanya mengurus memory/retrieval.
2. Workspace files tetap masuk ke model context.
3. Setelah surface berubah, konten bisa direindex ke memory backend.

Jadi flow yang sehat:

1. user memberi instruksi natural
2. agent memilih mutation plan
3. primary store + mirror file diupdate
4. `memory-langchain` mengindeks ulang perubahan
5. retrieval berikutnya ikut melihat state baru

---

## Non-Goals

Hal-hal ini bukan target v1 untuk plan ini:

- semua request diserahkan ke improvisasi model tanpa guardrail
- menghapus seluruh deterministic system
- menjadikan LangChain sebagai context engine
- membiarkan semua sender mengubah identity/profile tanpa auth
- menulis ke banyak file tanpa canonical contract

---

## Implementation Plan

### Phase 1. Domain and surface design

1. Tambah domain `assistant_workspace_mutation`.
2. Definisikan `WorkspaceMutationPlan`.
3. Definisikan `WorkspaceSurfaceId`.
4. Definisikan primary store vs mirror file contract.
5. Tambahkan surface tambahan:
   - `agent_rules`
   - `agent_boot`
   - `agent_tools_notes`
   - `heartbeat_checklist`
   - `bootstrap_lifecycle`
   - `workspace_memory`
   - `workspace_skill`
   - `knowledge_store`
   - `history_recall`

### Phase 2. General-agent planning path

1. Untuk self/profile mutation, jangan langsung jawab dari regex handler.
2. Route ke planner path yang menghasilkan mutation plan typed.
3. Planner harus support paraphrase yang berbeda dengan intent sama.
4. Planner harus bisa membedakan:
   - answer-only
   - workspace mutation
   - canonical memory mutation
   - transactional tool invocation

### Phase 3. Surface executors

1. Buat executor `agent_identity`.
2. Buat executor `owner_profile`.
3. Buat executor `agent_soul`.
4. Tambah sync helper ke:
   - `AGENTS.md`
   - `BOOT.md`
   - `IDENTITY.md`
   - `TOOLS.md`
   - `USER.md`
   - `SOUL.md`
   - `HEARTBEAT.md`
   - `BOOTSTRAP.md`
   - `MEMORY.md`
   - `memory/YYYY-MM-DD.md`
   - `skills/`

### Phase 4. LangChain sync integration

1. Setelah surface berubah, queue reindex terbatas.
2. Pastikan updated workspace files dan canonical facts terbaca lagi oleh retrieval.
3. Pastikan surface yang tidak boleh jadi source of truth tetap hanya menjadi supporting context, bukan primary state.

### Phase 5. Reduce old hardcoded handlers

1. Sempitkan `self-facts` menjadi canonical answer resolver, bukan mutation engine.
2. Sempitkan `memory-save` agar profile mutation typed datang dari shared mutation plan, bukan phrase-list utama.
3. Sempitkan `scheduling-intent` agar fokus pada transactional scheduling/action domains.
4. Jangan hilangkan acceptance coverage reminder/cron yang sudah terbukti live pada handover sebelumnya.

### Phase 6. Validation

1. Uji paraphrase cluster, bukan satu kalimat.
2. Uji live runtime, bukan test saja.
3. Uji drift antara primary store, mirror file, dan retrieval.

---

## Acceptance Criteria

- `nama anda sekarang adalah zoro`
  - mengubah identity secara durable
  - `siapa anda?` sesudahnya konsisten
- `mulai sekarang gunakan bun duluan di repo ini`
  - mengubah aturan kerja durable
  - surface yang dipilih konsisten (`AGENTS.md` atau `TOOLS.md`)
- `mulai sekarang panggil saya bevan`
  - mengubah owner profile canonical
  - `siapa saya?` sesudahnya konsisten
- `jawablah lebih singkat mulai sekarang`
  - mengubah assistant behavior durable
- `tambahkan checklist heartbeat untuk cek inbox dan calendar`
  - mengubah `HEARTBEAT.md` atau surface heartbeat yang setara
- `selesaikan bootstrap anda`
  - mengubah lifecycle bootstrap secara durable
- `simpan dokumen ini sebagai knowledge`
  - masuk ke knowledge store yang tepat, bukan ke owner profile atau generic note
- `cari lagi percakapan saya kemarin soal deploy`
  - masuk ke history retrieval, bukan ke docs atau owner profile
- `apa yang ada di memory saya tentang editor favorit?`
  - memilih `user_memory` atau canonical owner facts sesuai kebutuhan, bukan domain lain
- `cari docs OpenClaw tentang gateway token`
  - memilih `docs_kb`, bukan history atau owner profile
- paraphrase dengan makna sama menghasilkan action plan yang sama
- tidak perlu menambah regex satu per satu untuk phrasing baru
- state baru muncul konsisten di:
  - runtime reply
  - workspace files
  - retrieval yang relevan
- reminder/automation flows yang sudah lulus di `REMINDER_AUTOMATION_HANDOVER.md` tetap lulus:
  - route fidelity
  - URL/ISO/natural-time parsing
  - cron list/update/remove/follow-up
  - actionTarget/notifyTarget split
  - owner direct/group policy
  - domain separation
  - SSRF safe-by-default

---

## Dynamic Behavior Checklist

- [x] assistant identity mutation tidak bergantung pada exact phrase
- [x] assistant operating-rules mutation tidak bergantung pada exact phrase
- [x] owner profile mutation tidak bergantung pada exact phrase
- [x] persona/soul mutation tidak bergantung pada exact phrase
- [x] heartbeat mutation tidak bergantung pada exact phrase
- [x] bootstrap lifecycle mutation tidak bergantung pada exact phrase
- [x] curated memory write/update tidak bergantung pada exact phrase untuk cluster utama yang didukung
- [x] workspace-local skill mutation, jika dipilih, tidak bergantung pada exact phrase
- [x] self/runtime answers tetap canonical walau mutation path lebih dinamis
- [x] cron/reminder tetap memakai eksekusi terstruktur, tetapi intent parsing tidak phrase-hardcoded
- [x] route fidelity `same_chat` / thread/topic / configured_channel tetap terjaga
- [x] cron natural list/update/remove/follow-up tetap tersedia
- [x] `actionTarget` / `notifyTarget` tetap terpisah jelas
- [x] parser tetap menjaga URL / ISO / natural-time / recurring-reminder behavior yang sudah locked
- [x] owner direct/group auth, cross-channel merge, provenance-audit-only, dan sender-hint independence tetap terjaga
- [x] domain `docs_kb` / `history` / `memory` tetap dibedakan secara jujur
- [x] agent memahami mana yang injected-in-context vs mana yang perlu retrieval on-demand
- [x] agent memilih domain recall yang tepat (`user_memory`, `docs_kb`, `history`) tanpa keyword-hardcode sebagai fondasi utama
- [x] agent menghindari RAG yang tidak perlu bila jawaban sudah tersedia di canonical store atau injected context
- [x] private/LAN SSRF policy tetap safe-by-default
- [x] primary store dan mirror file tidak drift
- [x] `memory-langchain` tetap sinkron setelah mutation
- [x] auth policy jelas untuk siapa yang boleh mengubah identity/profile
- [x] live runtime proof tersedia, bukan hanya unit test

## Validation Notes (2026-03-29)

- Verified green with the official wrapper: `pnpm test -- src/auto-reply/self-facts.test.ts`, `pnpm test -- src/auto-reply/memory-save.test.ts`, `pnpm test -- src/auto-reply/memory-recall.test.ts`, `pnpm test -- src/auto-reply/scheduling-intent.test.ts`, `pnpm test -- src/auto-reply/reply/get-reply-run.media-only.test.ts`, `pnpm test -- src/agents/system-prompt.durable-workspace.test.ts`, `pnpm test -- src/auto-reply/reply/mutation-auth-prompt.test.ts`, and `pnpm test -- src/agents/tools/web-fetch.ssrf.test.ts`.
- Re-run validation on 2026-03-29 is green for the same focused suite (using `timeout 180s`) plus `src/agents/system-prompt.test.ts` with `OPENCLAW_TEST_PROFILE=serial OPENCLAW_TEST_SERIAL_GATEWAY=1` (`timeout 240s`).
- During re-run, one stale assertion in `src/agents/system-prompt.test.ts` was aligned from `memory backend` wording to the current `retrieval backend` wording, then the full file passed.
- `pnpm format` and `pnpm build` pass on the current branch after the stricter durable-mutation prompt updates.
- `pnpm test -- src/agents/system-prompt.test.ts` can stall under the default wrapper profile in this environment, but passes with `OPENCLAW_TEST_PROFILE=serial OPENCLAW_TEST_SERIAL_GATEWAY=1` plus `timeout 240s`.
- Live runtime proof: `proofsurfaces3` fresh workspace accepted `Panggilanmu Jade. Saat ngobrol, jawab lebih ringkas.` and rewrote `IDENTITY.md` with `Name: Jade`, showing durable identity mutation no longer depends on a magic phrase like “from now on”.
- Live runtime proof: `proofsurfaces4` fresh workspace accepted `Simpan aturan ini di workspace: tiap edit harus memakai referensi upstream yang dinamis dan tidak boleh bergantung pada regex atau trigger exact-word.` and appended the rule to `AGENTS.md`, not `TOOLS.md`.
- Live runtime proof: owner memory save with broader phrasing (`tolong ingat kalau framework favorit saya itu Astro`) writes the canonical fact and mirrors it into `USER.md`.
- Live runtime proof: owner memory recall (`apa yang ada di memory saya tentang framework favorit?`) now answers directly from canonical owner facts instead of falling through to empty RAG retrieval.
- Prompt/runtime hardening now explicitly forbids keyword banks, regex trigger lists, memorized sentence templates, and advisory-mode detours when the user is asking for a durable workspace mutation; the current-turn auth prompt also states that only explicit owner direct messages may mutate identity/profile/workspace files.
- SSRF safety is validated by `pnpm test -- src/agents/tools/web-fetch.ssrf.test.ts`.
- `memory-langchain` reachability is now green while a local Chroma server is running on `127.0.0.1:8889`; `openclaw memory status --json` shows `vector.available: true` and per-domain probes available for `user_memory`, `docs_kb`, and `history`.
- Live runtime proof (2026-03-29): `proofsurfaces4` accepted persona change and wrote it to `SOUL.md` (short, direct style) without relying on a magic phrase.
- Live runtime proof (2026-03-29): `proofsurfaces4` accepted heartbeat request and appended the checklist to `HEARTBEAT.md` without a keyword trigger.
- Live runtime proof (2026-03-29): `proofsurfaces4` confirmed `BOOTSTRAP.md` was removed when asked to close the bootstrap lifecycle.
- Live runtime proof (2026-03-29): `proofsurfaces4` created a workspace-local skill at `skills/weekly-release/SKILL.md` via natural instruction.
- Live runtime proof (2026-03-29): `proofsurfaces4` wrote canonical knowledge to `memory/knowledge/weekly-release-checklist.md`.
- Live runtime proof (2026-03-29): history recall answered correctly for a recent in-chat code (`ALFA-42`), showing history-domain retrieval when intent is history.
- Live runtime proof (2026-03-29): cron reminder scheduled via natural language; `openclaw cron list --json` shows the created job.
- Live runtime proof (2026-03-29): webhook/action request sent a POST to `https://httpbin.org/post` and confirmed receipt.
- Live runtime proof (2026-03-29): config/runtime intent verified by checking `gateway.mode` in `openclaw.json` (remains `local`) without adding extra keys.
- Live runtime proof (2026-03-29): “only answer” request (`2+2`) returned `4` and did not change `AGENTS.md` mtime in the proof workspace.
- Live runtime proof (2026-03-29): after adding a journal entry in the main workspace, `openclaw memory index --agent main --verbose` completed and `openclaw memory status --agent main --json` reports memory files indexed (sourceCounts for `memory` > 0) with an updated `lastSyncAt`, satisfying post-mutation `memory-langchain` sync.

---

## Recommendation

Kalau target Anda adalah “behavior seperti upstream, tetapi lebih robust”, maka arah terbaik bukan:

- kembali ke regex besar
- atau menyerahkan semuanya 100% ke model

arah terbaik adalah:

- **dynamic semantic planning**
- **general agent chooses action**
- **deterministic canonical execution**
- **workspace files stay first-class**
- **LangChain stays retrieval-oriented**

Dengan arsitektur ini, agent bisa terasa natural seperti upstream, tetapi tetap:

- konsisten
- aman
- bisa diaudit
- tidak mudah pecah hanya karena phrasing berubah
