# Reminder and Scheduled Automation Handover

## Purpose

Dokumen ini adalah handover untuk sesi AI berikutnya agar bisa melanjutkan perbaikan scheduling, reminder, dan scheduled automation dengan konteks yang lengkap tanpa mengulang audit dari nol.

Dokumen ini **bukan implementasi**, tetapi spesifikasi kerja dan ringkasan temuan aktual dari codebase saat ini.

Catatan penting:

- File ini sengaja dibuat sebagai file Markdown khusus di root workspace/repo.
- File ini **tidak otomatis ikut bootstrap context** pada sesi berikutnya seperti `AGENTS.md`, `TOOLS.md`, `USER.md`, dan file bootstrap lain.
- Jadi sesi berikutnya perlu **membaca file ini secara eksplisit** bila ingin memakai handover ini.
- Untuk target perilaku yang lebih dinamis dan upstream-like, baca juga `DYNAMIC_GENERAL_AGENT_PLAN.md`.

---

## Scope Yang Dikunci

Fokus v1:

1. Reminder natural language harus robust dan deterministic.
2. Scheduled automation harus bisa membedakan:
   - **aksi** yang dijalankan ke target tertentu
   - **notifikasi** hasil sukses/gagal ke target lain
3. Self-profile user harus canonical dan tidak lagi menjawab dari retrieval campuran.
4. Pertanyaan self/runtime assistant harus deterministic dan ringkas.

Out of scope untuk v1:

- Google Calendar
- Gmail sebagai target reminder/delivery
- Email delivery
- General-purpose workflow engine yang sangat luas
- Agent improvisation sebagai jalur utama untuk automation

Delivery target yang valid untuk v1:

- `same_chat`
- `configured_channel`
- `webhook`
- `internal`

Prinsip arsitektur yang dikunci:

- solusi **tidak boleh** bergantung pada daftar kalimat exact seperti:
  - `chat saya 1 menit lagi`
  - `chat lagi 1 menit`
  - `ping saya 1 menit lagi`
  - `kabari saya 1 menit lagi`
- contoh-contoh kalimat hanya dipakai sebagai **contoh test**, bukan sebagai daftar trigger resmi yang kaku
- sistem harus membaca **makna/slot intent**, bukan hanya mencocokkan susunan teks tertentu
- regex masih boleh dipakai sebagai helper level rendah untuk ekstraksi token tertentu seperti:
  - waktu
  - URL
  - unit durasi
  - channel identifier
- tetapi regex **tidak boleh menjadi satu-satunya mekanisme keputusan top-level**

---

## Temuan Utama dari Audit

## 1. Reminder saat ini belum robust

Masalah utama:

- Reminder masih terlalu bergantung pada heuristik frasa dan regex.
- Beberapa wording masih bisa jatuh ke model umum.
- Jika jatuh ke model umum, efeknya bisa:
  - bot typing terlalu lama
  - bot tidak memberi balasan klarifikasi cepat
  - reminder tidak dibuat secara deterministic

Contoh nyata yang pernah gagal:

- `chat saya 1 menit lagi untuk saya makan`

Masalah saat ini di code:

- `src/auto-reply/scheduling-intent.ts:25-26`
  - reminder masih diaktifkan dari regex intent family
- `src/auto-reply/scheduling-intent.ts:38-43`
  - parsing waktu saat ini kuat untuk:
    - relative duration
    - recurring interval
    - timestamp/absolute tertentu
  - tetapi belum cukup kuat untuk clock-style natural language seperti:
    - `jam 5 pagi`
    - `jam 7 malam`
    - `besok pagi jam 6`
- `src/auto-reply/scheduling-intent.ts:620-727`
  - reminder action saat ini hanya membangun satu target delivery

Kesimpulan:

- Jalur reminder sekarang sudah **lebih baik dari sebelumnya**, tetapi belum cukup general.
- Arsitektur reminder perlu naik dari regex-centric ke **slot-based intent parsing**.
- Target akhirnya bukan “menambah banyak regex baru”, tetapi mengganti keputusan intent dari pola exact ke parser yang membaca:
  - siapa yang harus dihubungi lagi
  - kapan
  - lewat mana
  - isi pengingatnya apa

Konsekuensi desain:

- jika nanti ada variasi kalimat seperti:
  - `ingatkan saya 1 menit lagi`
  - `chat saya lagi 1 menit lagi`
  - `ping saya 1 menit lagi`
  - `kabari saya satu menit lagi`
  - `tolong balas lagi 1 menit dari sekarang`
- semuanya seharusnya dipahami dari slot yang sama, bukan karena setiap variasi ditambahkan satu per satu ke regex utama

---

## 2. Scheduled automation belum punya model dua target

Contoh target use case:

- `setiap jam 5 pagi, matikan lampu rumah saya dengan webhook <url>, lalu kirim chat sukses ke telegram`

Kalimat seperti ini membutuhkan **dua target berbeda**:

1. `action target`
   - ke mana aksi dijalankan
   - contoh: webhook smart-home, Home Assistant, Node-RED, server automation

2. `notify target`
   - ke mana hasil dilaporkan
   - contoh: Telegram/chat ini/channel lain

Masalah saat ini:

- scheduling layer hanya mengenal **satu** konsep delivery target
- akibatnya sistem belum bisa secara natural memisahkan:
  - “jalankan aksi ke URL”
  - “setelah sukses, kirim konfirmasi ke chat”

Bukti di code:

- `src/auto-reply/scheduling-intent.ts:85-91`
  - `DeliveryResolution` saat ini hanya punya satu target:
    - `same_chat`
    - `internal`
    - `webhook`
    - `channel`
    - `none`
- `src/auto-reply/scheduling-intent.ts:684-717`
  - jika memilih `webhook`, job dibangun dengan `delivery.mode = "webhook"`
  - ini berarti webhook diperlakukan sebagai **delivery target**, bukan **action target**

Kesimpulan:

- model scheduling saat ini belum cukup untuk automation yang punya `action + notify`.
- perlu intent dan schema baru untuk scheduled automation.
- intent ini nanti juga **tidak boleh** dibangun sebagai pencocokan kalimat exact seperti:
  - `matikan lampu ... lalu kirim chat`
  - `turn off lamp ... then notify me`
- yang benar adalah parser membaca slot umum:
  - aksi apa
  - objek/perangkat apa
  - kapan
  - action target ke mana
  - notify target ke mana
  - pesan sukses/gagal apa

Konsekuensi desain:

- contoh lampu hanyalah contoh use case
- arsitektur yang dibangun harus reusable juga untuk pola lain seperti:
  - nyalakan perangkat
  - panggil endpoint tertentu
  - jalankan callback internal/webhook
  - kirim konfirmasi ke chat/channel lain

---

## 3. Cron webhook saat ini adalah delivery webhook, bukan action webhook

Ini adalah temuan arsitektural paling penting.

Perilaku saat ini:

- `delivery.mode = "webhook"` pada cron berarti:
  - setelah job selesai,
  - cron POST event hasil selesai ke URL itu

Ini **bukan** berarti:

- cron memakai URL itu sebagai aksi utama perangkat/API yang ingin dijalankan

Bukti docs:

- `docs/automation/cron-jobs.md:224-230`
  - cron webhook mode menulis finished event payload ke `delivery.to`
  - tidak ada channel delivery di mode ini
  - tidak ada main-session summary di mode ini

Bukti implementasi:

- `src/gateway/server-cron.ts:94-117`
  - `postCronWebhook(...)` melakukan `POST` dengan JSON payload
- `src/gateway/server-cron.ts:365-410`
  - webhook cron dipicu pada event `finished`

Implikasi:

- skenario:
  - “panggil webhook lampu”
  - lalu “chat sukses ke Telegram”
- **belum** punya template built-in satu langkah di cron sekarang

---

## 4. `web_fetch` bukan primitive yang tepat untuk device action

Kenapa ini penting:

- ada godaan untuk memaksa agentTurn melakukan automation lewat `web_fetch`

Masalahnya:

- `web_fetch` saat ini lebih cocok untuk fetch/read web content, bukan action API typed

Bukti:

- `src/agents/tools/web-fetch.ts:51-62`
  - schema hanya punya:
    - `url`
    - `extractMode`
    - `maxChars`
- tidak ada typed fields untuk:
  - `method`
  - `headers`
  - `body`
- `src/agents/tools/web-fetch.ts:538-549`
  - request dijalankan sebagai guarded fetch sederhana untuk content retrieval

Jadi:

- `web_fetch` mungkin cukup untuk GET sederhana
- tetapi **tidak layak dijadikan fondasi utama** untuk scheduled device automation

---

## 5. Endpoint smart-home private/LAN akan kena constraint SSRF

Ini sangat penting untuk use case rumah pintar.

Temuan:

- `web_fetch` memblokir hostname/IP private/internal secara default
- cron webhook POST juga menggunakan SSRF guard

Bukti:

- `src/agents/tools/web-fetch.ssrf.test.ts:76-120`
  - `localhost`, `127.0.0.1`, dan private/internal hosts diblok
- `src/gateway/server-cron.ts:108-117`
  - cron webhook memakai `fetchWithSsrFGuard`
- `src/infra/net/ssrf.ts:23-64`
  - ada policy SSRF dan konsep allowlist/private network policy

Implikasi:

- endpoint seperti:
  - `http://192.168.x.x/...`
  - `http://homeassistant.local/...`
  - `http://localhost:8123/...`
    kemungkinan diblok default
- untuk smart-home realistis, v1 perlu policy:
  - private endpoint **boleh**, tetapi hanya lewat **explicit allowlist**
- jangan buka global `allow all private network` sebagai default

Keputusan yang dikunci:

- v1 hanya mendukung private/LAN endpoint lewat **explicit allowlist**
- tidak ada default bypass SSRF

---

## 6. Cron-owned isolated runs memang bukan jalur “kirim chat sendiri dari dalam run”

Bukti:

- `src/cron/isolated-agent/run.ts:156-170`
  - cron-owned runs men-disable message tool internal

Implikasi:

- desain yang benar bukan:
  - biarkan job improvisasi kirim Telegram sendiri
- desain yang benar:
  - **payload menjalankan aksi**
  - **cron delivery** menangani notifikasi hasil

Ini justru bagus untuk robustness karena:

- separation of concerns lebih jelas
- idempotency dan retry lebih mudah dikontrol
- satu jalur untuk notify lebih mudah diuji

---

## 7. Self-profile user masih perlu canonical path khusus

Masalah yang masih terlihat dari audit sebelumnya:

- `siapa saya?` masih berisiko membaca hasil campuran dari:
  - canonical facts
  - `USER.md`
  - note lama
  - fact yang sudah superseded
  - retrieval ranking

Dampak:

- nama user bisa salah
- fact yang sudah dihapus masih bisa muncul
- update/delete tidak langsung terasa “final”

Arah perbaikan:

- `siapa saya?` harus dijawab dari **canonical active user facts only**
- jangan lewat generic retrieval
- jangan baca `USER.md` untuk jawaban self-profile aktif

Target typed facts minimum:

- `profile.name.full`
- `profile.name.preferred`
- `profile.aliases`
- typed preference/constraint facts lain yang memang canonical

---

## Target Arsitektur V1

## A. Reminder

Reminder adalah intent untuk:

- mengingatkan user pada waktu tertentu
- tanpa aksi eksternal yang kompleks

Reminder slots:

- `contactVerb`
- `recipient`
- `schedule`
- `deliveryTarget`
- `sourceRoute`

Rule:

- reminder dianggap lengkap hanya jika:
  - `schedule` terisi
  - `deliveryTarget` terisi
- jika target delivery belum jelas:
  - bot **harus** bertanya
- tidak ada default delivery diam-diam
- parser reminder harus berbasis **slot**, bukan daftar exact phrase
- satu keluarga intent reminder harus tetap terbaca meskipun:
  - urutan kata berubah
  - ada filler words
  - bahasa Indonesia dan Inggris bercampur
  - ada sinonim ringan seperti `ingatkan`, `kabari`, `ping`, `balas lagi`

Delivery choices v1:

- `same_chat`
- `configured_channel`
- `webhook`
- `internal`

---

## B. Scheduled automation

Scheduled automation adalah intent untuk:

- menjalankan aksi eksternal atau proses tertentu pada jadwal tertentu
- opsional mengirim notifikasi sukses/gagal

Automation slots:

- `actionVerb`
- `deviceOrAsset`
- `schedule`
- `actionTarget`
- `notifyTarget`
- `successMessage`
- `failureNotifyTarget` optional

Contoh:

- matikan lampu -> `actionVerb`
- webhook lampu/home-assistant -> `actionTarget`
- Telegram/chat ini -> `notifyTarget`

Rule:

- jangan modelkan ini sebagai reminder biasa
- ini harus menjadi intent/domain tersendiri
- parser scheduled automation juga harus berbasis **slot/action graph ringan**, bukan exact phrase list
- contoh lampu jangan dijadikan special-case hardcode
- selama user menyampaikan komponen inti yang sama, wording berbeda tetap harus bisa dipahami, misalnya:
  - aksi perangkat
  - jadwal
  - target aksi
  - target notifikasi
  - pesan sukses/gagal

---

## C. Cron payload model yang dibutuhkan

Cron perlu payload baru untuk automation typed.

Arah yang disarankan:

- tambahkan payload kind baru:
  - `payload.kind = "httpAction"`

Bentuk umumnya:

- `request.method`
- `request.url`
- `request.headers`
- `request.body`
- `success.whenStatus`
- `success.summaryText`
- `failure.summaryText`

Makna:

- `payload` = aksi utama
- top-level `delivery` = notifikasi sukses/default notification target
- `failureDestination` = target notifikasi gagal

Dengan ini:

- action dan notify tidak lagi bercampur

---

## D. Delivery capability registry

Scheduling dan automation harus memakai registry typed, bukan regex pilihan lepas.

Capability IDs:

- `same_chat`
- `configured_channel`
- `webhook`
- `internal`

Setiap capability harus bisa menjawab:

- available atau tidak
- label yang tampil ke user
- resolver
- kenapa unavailable

Penting:

- prompt klarifikasi dibangun dari capability aktif saat itu
- jangan hardcode daftar pilihan di banyak tempat
- registry ini harus menjadi sumber kebenaran tunggal untuk pilihan delivery
- jadi follow-up seperti:
  - `balas chat saja`
  - `telegram aja`
  - `ke webhook ini`
  - `internal aja`
    tidak di-handle oleh daftar regex yang tercerai-berai di banyak tempat, tetapi oleh resolver capability yang sama

---

## E. Self/runtime deterministic resolver

Pertanyaan berikut harus dijawab dari satu resolver deterministic yang konsisten:

- `siapa anda`
- `apa tugas anda`
- `apa model yang anda pakai`
- `apa orkestra model anda`

Aturan:

- ringkas
- tidak membawa nama OpenClaw/provider/plumbing kecuali diminta
- support compound question dalam satu turn

---

## Acceptance Criteria yang Harus Dipenuhi

## Reminder

- `chat saya 1 menit lagi untuk saya makan`
  - harus dikenali sebagai reminder
  - harus memberi balasan pertama cepat
  - typing tidak boleh bertahan sampai satu menit selesai
- variasi makna yang setara juga harus lolos tanpa perlu hardcode per kalimat
- `ingatkan saya 1 menit lagi`
  - harus minta target delivery
- `balas chat saja`
  - harus resolve ke current route
- `telegram aja`
  - hanya valid jika Telegram configured
- `internal aja`
  - membuat job tanpa external notify

## Scheduled automation

- Prompt lampu jam 5 pagi harus dipahami sebagai:
  - schedule
  - actionTarget
  - notifyTarget
- variasi wording yang maknanya sama juga harus dipahami tanpa membuat hardcode satu contoh per use case
- Cron job yang dihasilkan harus memisahkan:
  - action
  - success notify
  - optional failure notify
- Jika action target private/LAN dan tidak ada allowlist:
  - harus ditolak dengan penjelasan aman
- Jika allowlisted:
  - boleh dijalankan

## Self-profile

- `ingat nama saya ...`
  - harus masuk fact typed
- `siapa saya?`
  - hanya membaca active canonical facts
- fact deleted/superseded tidak boleh muncul lagi

## Runtime self facts

- jawaban harus singkat, deterministic, dan konsisten lintas channel

---

## Non-Goals untuk V1

Hal-hal ini sengaja **bukan fokus v1**:

- Google Calendar
- Gmail delivery target
- Email delivery target
- arbitrary workflow graph engine
- model improvisation sebagai jalur utama automation
- membuka private network tanpa allowlist
- generic smart-home provider abstraction yang sangat luas

---

## Risiko Jika Dibiarkan Tanpa Refactor

1. Reminder tetap wording-sensitive
2. Bot masih bisa jatuh ke model umum untuk scheduling
3. Typing delay dan UX buruk akan terus muncul
4. User akan mengira webhook cron bisa menjadi action hook, padahal saat ini hanya finished-event delivery
5. Smart-home/private endpoint use case akan gagal secara membingungkan
6. `siapa saya?` akan tetap rawan salah karena retrieval campuran
7. Tambahan fitur scheduling baru akan semakin sulit karena model konsep saat ini masih satu-target-only
8. Jika solusi tetap regex-per-kalimat, sistem akan cepat rapuh, sulit dipelihara, dan terus memerlukan patch wording baru

---

## Urutan Implementasi yang Disarankan

1. Bangun deterministic intent arbiter berbasis slot
2. Pisahkan `reminder` dan `scheduled_automation`
3. Tambah delivery capability registry
4. Tambah typed pending state untuk follow-up clarification
5. Tambah cron payload `httpAction`
6. Tambah SSRF private allowlist policy untuk scheduled action
7. Rapikan self-profile canonical projection
8. Satukan self/runtime deterministic resolver
9. Tambah regression tests lintas channel/shared reply pipeline

---

## File dan Surface yang Relevan

Scheduling / reminder:

- `src/auto-reply/scheduling-intent.ts`
- `src/auto-reply/reply/get-reply-run.ts`
- `src/config/sessions/types.ts`

Cron / delivery:

- `src/cron/types.ts`
- `src/cron/service/jobs.ts`
- `src/cron/isolated-agent/run.ts`
- `src/gateway/server-cron.ts`
- `docs/automation/cron-jobs.md`

Web / SSRF:

- `src/agents/tools/web-fetch.ts`
- `src/agents/tools/web-fetch.ssrf.test.ts`
- `src/infra/net/ssrf.ts`

Self-profile / memory:

- canonical user memory path and reply routing surfaces touched by self-profile answer logic

---

## Catatan untuk Sesi Berikutnya

Saat melanjutkan:

- jangan langsung patch regex lagi sebagai solusi utama
- jangan “menambal” tiap wording dengan exact regex baru kecuali itu hanya helper ekstraksi kecil
- jangan gunakan `web_fetch` sebagai fondasi device automation utama
- jangan campurkan lagi `action target` dan `notify target`
- jangan kembalikan opsi Google Calendar/email ke flow reminder v1
- jangan menjawab `siapa saya?` dari retrieval campuran

Prinsip desain yang harus dipertahankan:

- deterministic before model
- typed capability before prose
- canonical active facts before vector recall
- action target terpisah dari notify target
- private endpoint harus aman by default
- parser intent berbasis slot, bukan phrase allowlist
- contoh test tidak boleh berubah menjadi hardcode aturan produk

---

## Addendum: Temuan Yang Sudah Terbukti

Bagian ini hanya memuat hal-hal yang sudah terbukti lewat:

- pembacaan kontrak resmi code/docs/types
- simulasi lokal terhadap fungsi shared yang dipakai runtime
- atau kombinasi keduanya

Bagian ini sengaja dipisahkan dari arahan desain di atas. Jika ada konflik antara dugaan lama dan bagian ini, **anggap bagian ini lebih kuat** karena basisnya sudah tervalidasi.

### 1. Reminder biasa memang sudah punya template bawaan di OpenClaw

Ini sudah terbukti:

- scheduler bawaan resmi adalah cron Gateway di `docs/automation/cron-jobs.md:14`
- bentuk job resmi ada di `src/cron/types.ts:81` dan `src/agents/tools/cron-tool.ts:234`
- `sessionTarget: "current"` memang mode yang didukung resmi di `docs/automation/cron-jobs.md:91`

Kesimpulan:

- untuk reminder biasa, masalahnya **bukan** karena OpenClaw tidak punya scheduler bawaan
- masalahnya ada pada layer natural-language yang membangun atau mem-parse job tersebut

### 2. Layer natural-language reminder/scheduling adalah layer baru, bukan fitur percakapan lama yang diabaikan

Ini sudah terbukti:

- `src/auto-reply/scheduling-intent.ts` dibuat baru pada commit `9c9df631e5`
- `src/auto-reply/self-facts.ts` juga dibuat baru pada commit `9c9df631e5`
- sebelum itu, tidak ada handler front-door khusus untuk reminder natural language atau self/runtime reply

Kesimpulan:

- kita **tidak** menimpa fitur percakapan reminder lama yang sudah robust
- yang terjadi adalah kita menambahkan layer conversational shortcut baru di atas cron bawaan

### 3. Parser reminder saat ini memang masih gagal untuk beberapa wording umum

Ini sudah dibuktikan lewat simulasi langsung:

- `chat saya 1 menit lagi untuk saya makan` -> `buildDeterministicSchedulingContext(...)` mengembalikan `undefined`
- `kabari saya 1 menit lagi` -> `buildDeterministicSchedulingContext(...)` mengembalikan `undefined`
- follow-up waktu murni seperti `2 menit lagi` -> `resolvePendingSchedulingFollowup(...)` mengembalikan `undefined`
- follow-up waktu seperti `besok pagi jam 6` -> juga `undefined`

Implikasi:

- request seperti ini jatuh ke model umum
- jadi typing delay atau jawaban bebas memang bug nyata, bukan asumsi

Referensi:

- `src/auto-reply/scheduling-intent.ts:25`
- `src/auto-reply/scheduling-intent.ts:38`
- `src/auto-reply/scheduling-intent.ts:905`
- `src/auto-reply/scheduling-intent.ts:1033`

### 4. Input terstruktur seperti URL webhook dan ISO timestamp memang rusak di parser sekarang

Ini sudah dibuktikan lewat simulasi langsung:

- `ingatkan saya pada 2026-03-25T17:00:00Z untuk meeting`
  - hasilnya: waktu dianggap belum jelas
- `ingatkan saya 2 menit lagi via webhook https://example.com/hook`
  - hasilnya: bot masih meminta URL webhook lagi

Penyebabnya terbukti di code:

- `normalizeSchedulingQuery()` di `src/auto-reply/scheduling-intent.ts:97` membuang `:`, `.`, dan `/`

Implikasi:

- ini bukan masalah model
- ini bug parser yang nyata pada layer scheduling-intent

### 5. Reminder berulang masih salah diklasifikasikan sebagai monitoring

Ini sudah dibuktikan lewat simulasi langsung:

- `ingatkan saya setiap hari untuk minum obat`
  - hasilnya masuk jalur `periodic_monitoring`
  - bukan reminder berulang

Referensi:

- `src/auto-reply/scheduling-intent.ts:27`
- `src/auto-reply/scheduling-intent.ts:40`
- `src/auto-reply/scheduling-intent.ts:730`
- `src/auto-reply/scheduling-intent.ts:1061`

Kesimpulan:

- ini bug klasifikasi intent yang nyata

### 6. Reminder yang “berhasil” pun masih bisa mencampur isi pengingat dengan instruksi delivery

Ini sudah dibuktikan lewat simulasi langsung:

- `ingatkan saya 2 menit lagi dan balas ke chat ini`
  - memang menghasilkan job `cron.add`
  - tetapi isi pengingat menjadi `Pengingat: dan balas ke chat ini`

Referensi:

- `src/auto-reply/scheduling-intent.ts:151`
- `src/auto-reply/scheduling-intent.ts:559`

Kesimpulan:

- slot “isi pengingat” dan slot “cara delivery” memang belum benar-benar terpisah

### 7. `current session` + `deleteAfterRun` adalah bug nyata pada jalur yang sah, bukan sekadar risiko

Ini sudah terbukti dari code path dan simulasi:

- same-chat reminder dibangun dengan:
  - `sessionTarget: "current"`
  - `deleteAfterRun: true`
  - di `src/auto-reply/scheduling-intent.ts:595`
- core cron menormalkan `current` menjadi `session:<sessionKey>` di `src/cron/normalize.ts:453`
- runner cron memakai session key nyata itu di `src/gateway/server-cron.ts:283` dan `src/cron/isolated-agent/run.ts:364`
- setelah delivery sukses, cleanup memanggil `sessions.delete` terhadap session key itu di `src/cron/isolated-agent/delivery-dispatch.ts:442`

Kesimpulan:

- one-shot reminder ke chat yang sama saat ini terhubung untuk menghapus sesi live yang dipakai user setelah reminder selesai
- ini adalah bug nyata pada kombinasi fitur yang didukung resmi

### 8. Thread/topic memang hilang pada same-chat reminder builder saat ini

Ini sudah dibuktikan:

- context asal menangkap `threadId` di `src/auto-reply/scheduling-intent.ts:277`
- tetapi payload delivery same-chat yang dibangun tidak membawa `threadId`, hanya:
  - `channel`
  - `to`
  - `accountId`
  - di `src/auto-reply/scheduling-intent.ts:603`
- simulasi dengan `MessageThreadId: 777` menghasilkan `cron.add` tanpa `delivery.threadId`

Kesimpulan:

- bug ini nyata pada builder yang dipakai bersama
- untuk channel yang butuh field thread terpisah, reminder akan jatuh ke parent chat

### 9. Google Chat thread memang pasti tidak terjaga pada jalur reminder sekarang

Ini sudah terbukti:

- Google Chat monitor menyimpan thread sebagai `ReplyToId`, bukan `MessageThreadId`, di:
  - `extensions/googlechat/src/monitor.ts:257`
  - `extensions/googlechat/src/monitor.ts:264`
- scheduling-intent hanya membawa `MessageThreadId` di `src/auto-reply/scheduling-intent.ts:290`
- cron direct delivery meneruskan `threadId`, bukan `replyToId`, di `src/cron/isolated-agent/delivery-dispatch.ts:398`
- Google Chat outbound sendiri memang bisa pakai `threadId ?? replyToId` di `extensions/googlechat/src/channel.ts:279`
- tetapi reminder path sekarang tidak mengirim salah satu pun dari keduanya

Kesimpulan:

- reminder yang dibuat di thread Google Chat saat ini memang tidak punya jalur balik yang benar ke thread asal

### 10. OpenClaw inti memang belum punya model dua target untuk automation (`action webhook` + `notify chat`)

Ini sudah terbukti:

- payload cron inti hanya:
  - `systemEvent`
  - `agentTurn`
  - lihat `src/cron/types.ts:81`
- delivery mode inti hanya:
  - `none`
  - `announce`
  - `webhook`
  - lihat `src/cron/types.ts:20`
- `delivery.mode = "webhook"` secara resmi berarti:
  - POST finished event payload
  - bukan action target
  - lihat `docs/automation/cron-jobs.md:224`
  - dan implementasinya di `src/gateway/server-cron.ts:94`

Kesimpulan:

- untuk use case seperti:
  - panggil webhook perangkat
  - lalu kirim sukses ke Telegram
- saat ini memang **tidak ada** shape native di core cron untuk itu
- jadi pada poin ini, bukan kita mengabaikan fitur OpenClaw yang sudah ada

### 11. Self/runtime deterministic reply adalah layer baru di atas sumber data bawaan, bukan fitur percakapan lama yang di-bypass

Ini sudah terbukti:

- sumber data identitas bawaan memang sudah ada di:
  - `src/agents/identity.ts:8`
  - `src/agents/identity-file.ts:89`
- tetapi handler percakapan khusus `siapa anda / model apa yang dipakai` baru masuk lewat:
  - `src/auto-reply/reply/get-reply-run.ts:530`
  - `src/auto-reply/self-facts.runtime.ts`
  - `src/auto-reply/self-facts.ts`

Kesimpulan:

- kita tidak menimpa jalur percakapan lama yang robust
- kita sedang membangun jawaban conversational di atas sumber data identitas/config yang memang sudah ada

### 12. Memory/profile recall memang punya primitive bawaan, tetapi belum punya jalur final-answer deterministic lama yang kita abaikan

Ini sudah terbukti:

- primitive retrieval bawaan memang ada di:
  - `src/agents/tools/memory-tool.ts:85`
  - `src/agents/memory-search.ts:16`
- tetapi jalur deterministic recall baru masuk lewat:
  - `src/auto-reply/reply/get-reply-run.ts:563`
  - `src/auto-reply/memory-recall.runtime.ts`
- bahkan sekarang pun, kebanyakan recall masih mengembalikan `note + systemPromptHint`, bukan `directReply`, di:
  - `src/auto-reply/memory-recall.ts:469`
  - `src/auto-reply/reply/get-reply-run.ts:628`

Kesimpulan:

- di area ini juga tidak ada fitur percakapan deterministic lama yang sedang kita bypass
- yang ada adalah retrieval primitives bawaan, lalu kita tambah lapisan routing conversational di atasnya

### 13. Tidak ada kontradiksi antara poin 11-12 dan bug-bug baru di layer conversational

Ini perlu ditegaskan agar sesi berikutnya tidak bingung:

- poin 11-12 hanya menjawab pertanyaan:
  - “apakah kita mengabaikan fitur percakapan bawaan OpenClaw yang sudah robust?”
- jawabannya: **tidak**

Tetapi itu **tidak** berarti layer baru kita sudah benar.

Artinya:

- sumber data dan primitive bawaan memang sudah ada
- tetapi layer conversational/deterministic yang baru ditambahkan tetap bisa punya bug sendiri

Jadi:

- “tidak membypass fitur lama” dan
- “layer baru sekarang masih bugged”

keduanya bisa benar secara bersamaan.

### 14. `user_memory` canonical saat ini memang global per workspace, belum scoped per orang

Ini sudah terbukti lewat repro langsung:

- `upsertUserMemoryFact()` hanya mencari fact aktif berdasarkan:
  - `namespace`
  - `key`
  - `status === "active"`
  - di `src/memory/user-memory-store.ts:107`
- `provenance.senderId` disimpan, tetapi **tidak** dipakai sebagai bagian identity key

Repro yang sudah dijalankan:

- fact pertama:
  - sender `alice`
  - `preferences.database.favorite = DuckDB`
- fact kedua:
  - sender `bob`
  - `preferences.database.favorite = PostgreSQL`
- hasilnya:
  - fact Alice menjadi `superseded`
  - fact Bob menjadi `active`

Kesimpulan:

- satu user memang bisa menimpa fact user lain jika `namespace + key` sama
- jadi untuk self-profile multi-user, ini bug nyata di canonical store saat ini

### 15. Canonical `user_memory` JSON facts memang tidak masuk jalur builtin default, dan juga tidak terbaca di QMD default/core path

Status temuan ini: **partially valid dengan batas yang jelas**

Yang sudah terbukti:

#### Builtin backend

- scanner memory default hanya mengambil `.md` atau file multimodal, bukan `.json`, di:
  - `src/memory/internal.ts:67`
  - `src/memory/internal.ts:108`
- builtin sync mengindeks hasil `listMemoryFiles()` di:
  - `src/memory/manager-sync-ops.ts:706`
- builtin `readFile()` menolak path non-`.md` di:
  - `src/memory/manager.ts:687`

Repro yang sudah dijalankan:

- setelah `upsertUserMemoryFact()`, `listMemoryFiles()` tidak memuat file JSON fact
- setelah menulis docs KB markdown, file `.md` itu langsung muncul di enumerasi memory files

Kesimpulan builtin:

- canonical JSON fact memang tidak masuk jalur search/index builtin default

#### QMD default/core path

- default collection QMD hanya:
  - `MEMORY.md`
  - `memory.md`
  - `memory/**/*.md`
  - di `src/memory/backend-config.ts:275`
- `QmdMemoryManager.readFile()` juga menolak non-`.md` di:
  - `src/memory/qmd-manager.ts:919`

Kesimpulan QMD default/core:

- canonical JSON fact juga tidak terbaca di jalur ini

Catatan batas:

- ini **bukan** klaim bahwa semua konfigurasi QMD kustom di dunia pasti tidak bisa
- yang sudah terbukti adalah:
  - builtin default
  - QMD default/core path

### 16. Split domain `docs_kb/history` memang runtuh lagi ke `memory/sessions` di core path

Ini sudah terbukti:

- mapping domain mengharapkan:
  - `docs_kb -> ["docs", "repo"]`
  - `history -> ["chat", "email", "sessions"]`
  - di `src/memory/domain.ts:3`
- tetapi resolved search sources inti hanya:
  - `memory`
  - `sessions`
  - di `src/agents/memory-search.ts:15`
- QMD bootstrap juga mereduksi semua collection non-session menjadi `memory` di:
  - `src/memory/qmd-manager.ts:282`

Repro/logika yang sudah dijalankan:

- `resolveDomainSources("docs_kb")` menghasilkan `docs, repo`
- source default yang tersedia pada core path hanya `memory`
- intersection-nya kosong

Kesimpulan:

- `docs_kb` memang runtuh ke jalur `memory`
- `history` juga tidak dipertahankan penuh; yang tersisa di jalur default hanyalah `sessions`

### 17. Scope denial QMD memang jatuh menjadi “no matches”, bukan “access restricted”

Ini sudah terbukti:

- `QmdMemoryManager.search()` langsung mengembalikan `[]` saat scope tidak diizinkan di:
  - `src/memory/qmd-manager.ts:736`
- pada saat yang sama:
  - `status()` tetap melaporkan vector available di `src/memory/qmd-manager.ts:960`
  - `probeVectorStatus()` tetap menandai domain available di `src/memory/qmd-manager.ts:989`
- layer recall lalu mengubah hasil kosong itu menjadi `no matches` di:
  - `src/auto-reply/memory-recall.ts:573`

Kesimpulan:

- user-facing hasilnya memang bisa terlihat seperti:
  - “memori kosong”
- padahal kenyataannya:
  - “akses dibatasi oleh scope chat ini”

### 18. Pertanyaan runtime singkat memang masih gampang lolos dari deterministic layer

Ini sudah dibuktikan lewat simulasi langsung:

- `buildDeterministicSelfReplyContext(..., "model apa yang kamu pakai sekarang?")` -> `undefined`
- `buildDeterministicSelfReplyContext(..., "webhook aktif?")` -> `undefined`
- `buildDeterministicSchedulingContext(..., "cron aktif nggak?")` -> `undefined`

Referensi matcher:

- `src/auto-reply/self-facts.ts:10`
- `src/auto-reply/self-facts.ts:90`
- `src/auto-reply/scheduling-intent.ts:19`
- `src/auto-reply/scheduling-intent.ts:1033`

Kesimpulan:

- pertanyaan pendek capability/runtime masih terlalu bergantung pada bentuk phrasing tertentu

### 19. Guard “janji reminder palsu” memang efektifnya masih English-only

Ini sudah dibuktikan lewat simulasi langsung:

- `hasUnbackedReminderCommitment("Saya akan mengingatkan Anda besok pagi")` -> `false`
- `hasUnbackedReminderCommitment("Siap, saya ping kamu nanti")` -> `false`
- `hasUnbackedReminderCommitment("I will remind you tomorrow morning")` -> `true`

Referensi:

- `src/auto-reply/reply/agent-runner-reminder-guard.ts:6`

Kesimpulan:

- guard ini saat ini belum cukup melindungi output reminder palsu dalam bahasa Indonesia

### 20. Deterministic self-facts memang tidak memakai resolution stack yang sama dengan runtime efektif

Ini sudah terbukti dalam dua bagian:

#### Identitas

- `buildIdentityReply()` hanya membaca `IDENTITY.md` di:
  - `src/auto-reply/self-facts.ts:122`
- runtime umum memakai config identity via:
  - `src/agents/identity.ts:60`

Kesimpulan:

- jika config identity ada tetapi `IDENTITY.md` tidak ada, jawaban self-facts bisa tidak sinkron dengan runtime identity sebenarnya

#### Model fallback

- `self-facts` memakai:
  - `runtime?.textFallbacks ?? resolveAgentModelFallbackValues(...)`
  - di `src/auto-reply/self-facts.ts:130`
- jika caller memasok `runtime.textFallbacks = []`, default fallback config tertutup

Kesimpulan:

- jawaban self-facts bisa under-report fallback efektif dibanding runtime umum

### 21. Expanded cron audit: realistic conversational cases tambahan memang terbukti masih tidak lazim

Semua poin pada bagian ini sudah divalidasi lewat:

- `buildDeterministicSchedulingContext(...)`
- `resolvePendingSchedulingFollowup(...)`
- `node openclaw.mjs cron status --json`
- `node openclaw.mjs cron list --json`
- create/update/remove temp cron job nyata lewat gateway runtime

#### Reminder via webhook dengan URL eksplisit masih gagal

- Case uji:
  - `ingatkan saya 2 menit lagi via webhook https://example.com/hook`
- Hasil aktual:
  - bot masih membalas `Saya perlu URL webhook-nya dulu`
- Penyebab yang terbukti:
  - normalisasi query merusak URL di:
    - `src/auto-reply/scheduling-intent.ts:97`
  - target webhook lalu tidak bisa diekstrak di:
    - `src/auto-reply/scheduling-intent.ts:684`

#### URL-only target juga belum dianggap target webhook yang valid

- Case uji:
  - `ingatkan saya 2 menit lagi https://example.com/hook`
- Hasil aktual:
  - bot menganggap target reminder belum dipilih
- Kesimpulan:
  - URL tanpa kata `webhook` saat ini tetap gagal masuk sebagai target valid setelah normalisasi merusak bentuk URL

#### Dua target dalam satu kalimat masih runtuh jadi satu target saja

- Case uji:
  - `ingatkan saya 2 menit lagi via webhook lalu balas ke chat ini`
- Hasil aktual:
  - job dibuat sebagai `same_chat`
  - frasa `via webhook lalu balas ke chat ini` ikut bocor ke teks reminder
- Penyebab yang terbukti:
  - resolver delivery saat ini hanya memilih satu `DeliveryResolution`:
    - `src/auto-reply/scheduling-intent.ts:85`
  - teks reminder masih dibentuk dari query yang belum dibersihkan sempurna:
    - `src/auto-reply/scheduling-intent.ts:163`

#### Waktu alami seperti `besok jam 7 pagi` masih belum dipahami

- Case uji:
  - `ingatkan saya besok jam 7 pagi via webhook https://example.com/hook`
- Hasil aktual:
  - bot mengatakan waktu belum jelas
- Penyebab yang terbukti:
  - parser saat ini hanya kuat untuk:
    - relative duration
    - recurring interval numerik
    - ISO/timestamp
  - lihat:
    - `src/auto-reply/scheduling-intent.ts:180`
    - `src/auto-reply/scheduling-intent.ts:207`

#### Scheduled automation masih disalahpahami sebagai monitoring

- Case uji:
  - `setiap hari jam 2 malam nyalakan lampu kamar mandi dengan webhook https://example.com/hook`
- Hasil aktual:
  - masuk `periodic_monitoring`
  - bot minta interval lagi
- Case uji:
  - `setiap 1 hari nyalakan lampu kamar mandi dengan webhook`
- Hasil aktual:
  - tetap dianggap monitoring berkala, bukan aksi device
- Penyebab yang terbukti:
  - routing `periodic_monitoring` aktif dari:
    - `src/auto-reply/scheduling-intent.ts:27`
  - eksekusi berkala masih membentuk prompt monitoring:
    - `src/auto-reply/scheduling-intent.ts:527`
    - `src/auto-reply/scheduling-intent.ts:745`

#### Dua target pada recurring automation juga masih runtuh ke satu target

- Case uji:
  - `setiap 1 hari nyalakan lampu kamar mandi dengan webhook lalu balas ke chat ini`
- Hasil aktual:
  - job dibuat sebagai monitoring + `announce` ke chat ini
  - bagian webhook ikut tertinggal di teks prompt monitoring
- Kesimpulan:
  - model dua target `action target + notify target` memang belum ada di jalur conversational saat ini

#### Query list, edit, dan delete cron via chat belum ada secara deterministic

- Case uji:
  - `cronjob atau reminder atau jadwal rutin apa yang sekarang tersedia`
- Hasil aktual:
  - salah masuk reminder dan diminta waktu
- Case uji:
  - `jadwal rutin apa yang aktif sekarang`
- Hasil aktual:
  - `undefined` di deterministic scheduling, self-facts, dan memory recall
  - sehingga jatuh ke model umum
- Case uji:
  - `ganti webhook job pengingat saya ke https://example.com/hook2`
- Hasil aktual:
  - salah masuk reminder dan diminta waktu
- Case uji:
  - `hapus reminder saya yang tadi`
- Hasil aktual:
  - salah masuk reminder dan diminta waktu

#### Follow-up update target juga belum didukung

- Case uji:
  - setelah pending reminder `ingatkan saya 2 menit lagi via webhook`
  - follow-up `https://example.com/hook2`
- Hasil aktual:
  - target tidak berubah
- Case uji:
  - follow-up `ganti webhook ke https://example.com/hook2`
- Hasil aktual:
  - bot tetap mengatakan URL webhook masih dibutuhkan
- Kesimpulan:
  - follow-up resolver saat ini belum mendukung target mutation; ia baru mendukung selection sederhana

#### Structured cron OpenClaw sendiri tetap sehat

- Ini juga sudah terbukti:
  - `node openclaw.mjs cron status --json` sukses
  - `node openclaw.mjs cron list --json` sukses
  - create/update/remove temp job sukses
- Jadi:
  - yang rusak adalah layer conversational di atas cron
  - bukan backend cron core OpenClaw-nya

### 22. Tidak ada kontradiksi antara poin 21 dan kesimpulan lama tentang core cron

Bagian ini penting agar sesi berikutnya tidak salah baca:

- poin lama sudah membuktikan bahwa:
  - cron core OpenClaw memang ada
  - structured add/list/update/remove memang tersedia
- poin 21 membuktikan bahwa:
  - jalur conversational sekarang belum memetakan niat user ke structured cron action dengan benar

Jadi:

- `core cron sehat`
- `layer conversational cron masih rapuh`

keduanya benar secara bersamaan.

### 23. Arah vNext yang dipilih untuk `user_memory`: owner profile all-in-one, direct-only

Keputusan desain untuk fase berikutnya:

- `user_memory` tidak lagi diperlakukan sebagai multi-user profile store
- target produk yang dipilih adalah:
  - **satu owner profile canonical per workspace**
  - lintas channel owner tetap mengarah ke profile yang sama

Read policy yang dipilih:

- **direct only**

Write policy yang dipilih:

- **direct only**

Penting:

- poin 14 tetap benar sebagai **current-state audit**
- arah baru ini adalah **future design target**

Tidak ada kontradiksi di sini:

- current state:
  - global-by-accident
  - berbahaya untuk multi-user
- future target:
  - global-by-design
  - tetapi khusus owner profile tunggal
  - dan dibatasi hanya untuk direct owner routes

### 24. Additional proven findings yang relevan untuk model owner all-in-one

#### Repo sudah punya helper owner identity yang bisa dipakai ulang

- Ini sudah terbukti lewat simulasi langsung:
  - `resolveCommandAuthorization(...)` memang bisa menandai sender owner bila allowlist cocok
- Referensi:
  - `src/auto-reply/command-auth.ts:260`

Kesimpulan:

- implementasi owner all-in-one tidak perlu menciptakan identity subsystem baru dari nol
- owner allowlist yang sudah ada bisa dipakai ulang

#### Tetapi helper owner saja tidak cukup untuk direct-only policy

- Ini juga sudah terbukti lewat simulasi langsung:
  - owner yang sama di `ChatType: "group"` tetap ditandai owner oleh helper
- Referensi context:
  - `src/auto-reply/templating.ts:102`
  - `src/auto-reply/command-auth.ts:337`

Kesimpulan:

- kalau ingin direct-only policy, implementasi wajib menambah guard:
  - `senderIsOwner === true`
  - dan
  - `ChatType === "direct"`

#### Current canonical store sudah setengah mirip owner all-in-one, tetapi belum aman dan belum konsisten

- Sudah terbukti:
  - write path global by key:
    - `src/memory/user-memory-store.ts:119`
  - provenance sender/provider hanya audit metadata:
    - `src/memory/user-memory-store.ts:14`
    - `src/auto-reply/memory-save.ts:83`
  - recall path masih menambahkan sender hints:
    - `src/auto-reply/memory-recall.ts:187`
- Kesimpulan:
  - write path, read path, dan self-profile path belum berbicara dengan model identitas yang sama

#### Full name owner masih belum typed

- Ini sudah terbukti:
  - `ingat nama saya, bevantyo satria pinandhita`
  - masih jatuh ke:
    - `profile.note.<hash>`
- Referensi:
  - `src/auto-reply/memory-save.ts:217`

Kesimpulan:

- untuk owner all-in-one yang benar, name facts harus punya key typed tersendiri

### 25. Implementation-ready plan untuk fase berikutnya

#### Summary

- pertahankan cron core OpenClaw sebagai backend structured execution
- bangun routing conversational cron yang benar-benar deterministic untuk:
  - create reminder
  - create automation
  - list jobs
  - update jobs
  - remove jobs
  - status jobs
- pertahankan scope delivery v1 tetap:
  - `same_chat`
  - `configured_channel`
  - `webhook`
  - `internal`
- jadikan `user_memory` sebagai **single owner profile** per workspace
- batasi read/write owner profile ke **direct owner chats only**

#### Cron key changes

- pisahkan intent cron menjadi:
  - `cron_create_reminder`
  - `cron_create_automation`
  - `cron_list_jobs`
  - `cron_update_job`
  - `cron_remove_job`
  - `cron_status`
- jangan pakai satu query normalized yang destruktif untuk semua hal
  - simpan raw query untuk URL extraction dan time parsing
  - normalized query hanya untuk intent keywords
- list/edit/delete harus diproses sebelum create-reminder routing
- `configured_channel` tetap termasuk scope v1
  - gunakan registry delivery yang sama dengan:
    - `same_chat`
    - `webhook`
    - `internal`
- `besok jam 7 pagi`, `setiap hari jam 2 malam`, dan phrasing clock-time serupa harus diparse sebagai schedule yang valid
- recurring automation harus punya model:
  - `actionTarget`
  - `notifyTarget`
- jangan map device action ke `delivery.mode="webhook"`
  - mode itu tetap finished-event callback saja
- reminder biasa tetap punya **satu** target delivery
- scheduled automation harus mendukung **dua** target:
  - `actionTarget`
  - `notifyTarget`
- jika query scheduled automation belum cukup jelas untuk memisahkan dua target itu:
  - minta klarifikasi
  - jangan collapse diam-diam ke satu target
- update/remove via chat harus resolve ke existing job:
  - pakai job yang paling baru dibahas bila unambiguous
  - fallback ke name match
  - jika banyak kandidat, minta klarifikasi

#### Owner all-in-one memory key changes

- pakai satu owner profile canonical per workspace
- read owner profile hanya boleh jika:
  - `senderIsOwner === true`
  - dan
  - `ChatType === "direct"`
- write owner profile hanya boleh jika:
  - `senderIsOwner === true`
  - dan
  - `ChatType === "direct"`
- provenance tetap disimpan, tetapi audit-only
- self-profile query tidak boleh lagi memakai sender-hint retrieval
- `siapa saya?` dan pertanyaan owner profile harus membaca canonical active facts langsung
- `ingat nama saya ...` harus menulis key typed:
  - `profile.name.full`
  - dan typed identity fields terkait
- generic note fallback tetap boleh ada untuk fact yang benar-benar belum typed

#### Test plan

- reminder via webhook dengan URL eksplisit
- reminder via URL-only tanpa kata `webhook`
- reminder dua target dalam satu kalimat
- reminder dengan natural time seperti `besok jam 7 pagi`
- reminder ke `configured_channel`
- recurring automation dengan clock-time
- recurring automation dengan `actionTarget + notifyTarget`
- list active jobs via chat
- update existing job via chat
- remove existing job via chat
- owner direct Telegram write lalu owner direct WhatsApp overwrite key yang sama
  - harus menjadi update owner profile yang disengaja
- owner group read/write
  - harus ditolak oleh direct-only policy
- non-owner direct/group read/write
  - harus ditolak untuk owner profile
- full-name save
  - tidak boleh lagi jatuh ke `note.<hash>`

#### Assumptions and defaults

- target produk memory untuk fase ini adalah:
  - owner single-user all-in-one
  - bukan multi-user profile store
- direct-only policy berlaku untuk owner profile read dan write
- cron list generic menampilkan jobs aktif
- query dengan `semua` atau wording setara boleh meng-include disabled jobs
- jika update/remove query tidak menemukan satu job yang jelas:
  - sistem harus klarifikasi
  - bukan membuat reminder baru

#### Dynamic natural-language audit vs upstream

Bagian ini adalah audit arsitektur, bukan hanya audit runtime. Tujuannya untuk menjawab pertanyaan penting:

- apakah jalur natural-language sekarang benar-benar dinamis
- apakah terlalu bergantung pada regex atau phrase list
- apakah pendekatan ini berasal dari upstream, atau lahir di fork/workspace ini

#### Proven code-audit findings

1. `self-facts`, `scheduling-intent`, `memory-save`, dan `memory-recall` deterministic **bukan** baseline upstream.

- Bukti:
  - `git diff --stat upstream/main` menunjukkan file berikut sebagai penambahan besar di fork ini:
    - `src/auto-reply/self-facts.ts`
    - `src/auto-reply/scheduling-intent.ts`
    - `src/auto-reply/memory-save.ts`
    - `src/auto-reply/memory-recall.ts`
  - `git show upstream/main:src/auto-reply/self-facts.ts`
    - file itu **tidak ada** di upstream
  - `git show upstream/main:src/auto-reply/memory-save.ts`
    - file itu **tidak ada** di upstream
- Kesimpulan:
  - lapisan deterministic natural-language yang sekarang kita audit memang lahir di fork/workspace ini, bukan desain bawaan upstream.

2. Upstream lebih banyak menyerahkan pertanyaan natural-language ke jalur reply/model/tool umum.

- Bukti:
  - jalur reply upstream di `src/auto-reply/reply/get-reply-run.ts` tidak memanggil `self-facts`, `memory-save`, `memory-recall`, atau `scheduling-intent` deterministic seperti fork ini.
  - upstream system prompt di `src/agents/system-prompt.ts:44-53` mendorong agent memakai `memory_search` dan `memory_get`, bukan owner-profile resolver typed seperti di fork ini.
  - pencarian upstream untuk `siapa anda`, `nama saya`, dan owner-profile typed tidak menemukan surface typed setara di `src/auto-reply`.
- Kesimpulan:
  - upstream terasa lebih “natural” karena lebih model-driven, bukan karena punya parser semantic NL khusus yang lebih canggih.

3. Fork saat ini memakai pola campuran, bukan semantic parser murni.

- Bukti:
  - `src/auto-reply/reply/get-reply-run.ts:679-724`
    - fork sekarang menjalankan deterministic scheduling lebih dulu, lalu self-facts, baru setelah itu jatuh ke jalur lain
  - artinya pemahaman natural-language saat ini sangat dipengaruhi oleh front-door arbiter yang kita tambahkan sendiri
- Kesimpulan:
  - saat ini sistem bukan “full model-driven seperti upstream”, tetapi juga belum “semantic slot/classifier” yang rapi.

#### Current-state map by file

1. `src/auto-reply/scheduling-intent.ts`

- Status:
  - **regex-heavy**
- Bukti:
  - file ini punya bank matcher top-level seperti:
    - `REMINDER_VERB_RE`
    - `CRON_LIST_QUERY_RE`
    - `CRON_UPDATE_QUERY_RE`
    - `RELATIVE_TIME_RE`
    - `DAILY_CLOCK_RE`
    - `NATURAL_CLOCK_RE`
  - lihat blok awal di `src/auto-reply/scheduling-intent.ts:29-80`
- Implikasi:
  - lebih baik dari hardcode satu kalimat, tetapi masih rawan beda phrasing -> beda route
  - ini belum semantic slot parser yang umum

2. `src/auto-reply/self-facts.ts`

- Status:
  - **cue-based / token-based**
- Bukti:
  - file ini memakai `tokenizeCueText`, `hasCueToken`, `hasCuePhrase`, dan set token seperti:
    - `SELF_TOKENS`
    - `TASK_TOKENS`
    - `WEBHOOK_TOKENS`
    - `ORCHESTRA_TOKENS`
  - lihat `src/auto-reply/self-facts.ts:18-27`, `src/auto-reply/self-facts.ts:179-198`, dan `src/auto-reply/self-facts.ts:307-317`
- Implikasi:
  - ini tidak lagi exact-sentence regex saja
  - tetapi masih belum semantic classification berbasis makna umum

3. `src/auto-reply/memory-save.ts`

- Status:
  - **typed, tetapi phrase-list based**
- Bukti:
  - owner identity seperti `name.full` memang sudah typed
  - tetapi ekstraksinya masih bergantung pada `fieldPhrases`, misalnya:
    - `["nama", "saya"]`
    - `["my", "name"]`
  - lihat `src/auto-reply/memory-save.ts:311-380`
- Implikasi:
  - ini lebih kuat dari note-hash generic
  - tetapi tetap belum invariant terhadap banyak paraphrase bahasa alami

4. `src/auto-reply/memory-recall.ts`

- Status:
  - **typed owner-profile read + domain routing**
- Bukti:
  - file ini memang sudah punya jalur typed untuk owner profile, misalnya `name.full`
  - tetapi masih berdampingan dengan domain routing yang sensitif pada backend availability dan scope
- Implikasi:
  - jalur ini lebih canonical dibanding upstream
  - tetapi robustness user-facing tetap tergantung kualitas routing dan backend state

#### Practical conclusion

- Untuk pertanyaan seperti `siapa anda`, `apa model yang anda pakai`, dan sebagian capability question:
  - fork ini sekarang **lebih deterministic** daripada upstream
  - tetapi **belum sepenuhnya dinamis**
- Untuk reminder/cron:
  - fork ini masih **terlalu regex-heavy**
- Untuk owner memory:
  - fork ini sudah **lebih typed** dari upstream
  - tetapi ekstraksinya masih **phrase-list based**

#### Direction if the goal is “dynamic but still canonical”

Target jangka berikutnya sebaiknya:

1. classifier/arbiter intent berbasis slot

- output:
  - `intent`
  - `slots`
  - `confidence`
- bukan jawaban final langsung

2. resolver canonical per domain

- `self_identity`
- `self_role`
- `self_runtime`
- `reminder_create`
- `automation_create`
- `owner_profile_read`
- `owner_profile_write`

3. regex dibatasi hanya untuk primitive teknis

- URL
- timestamp ISO
- cron expression
- angka durasi

4. phrase list hanya jadi helper extraction, bukan decision engine utama

5. semua paraphrase yang bermakna sama harus converge ke:

- intent yang sama
- slot yang sama
- jawaban final yang sama

#### Final cross-check checklist

- Status checklist di bawah ini sudah di-cross-check ulang terhadap runtime gateway yang sedang jalan.
- Test hijau, `pnpm tsgo`, `pnpm build`, `pnpm check`, dan probe deterministic tetap berguna, tetapi **tidak cukup** untuk status `[O]` pada bagian ini.
- `[O]` hanya boleh dipakai bila claim-nya sudah terbukti pada runtime prod-like yang aktif.
- `[X]` berarti: claim-nya masih gagal di runtime live, atau belum bisa dianggap valid karena belum terbukti live non-simulasi.
- Untuk audit kali ini, yang dihitung hanya gateway aktif saat ini di `127.0.0.1:18789`. Klaim yang sebelumnya bergantung pada gateway isolasi di port lain saya turunkan lagi bila tidak bisa saya ulang di runtime aktif ini.
- Beberapa item `[O]` di bawah masih menyebut contoh session/job proof lama, tetapi statusnya sudah saya cross-check ulang fresh pada gateway aktif saat ini; item yang tidak bisa saya ulang atau yang hasil live-nya berubah sudah saya turunkan ke `[X]`.
- Jika sebuah item di bawah secara eksplisit menyebut `code-audit` atau `upstream-audit`, item itu diverifikasi terhadap source tree/branch upstream, bukan hanya gateway live.

- [O] `same_chat` one-shot reminder tidak lagi menghapus sesi live user setelah run selesai
  - Alasan audit: fresh live `chat.send` di session `agent:main:webchat:direct:samechat-direct-0328` membuat reminder `balas ke chat ini` 6 detik. Setelah run selesai, `chat.history` pada gateway aktif tetap menampilkan sesi yang sama dengan dua message berurutan: konfirmasi schedule dan reminder final `Waktunya samechat-direct-0328!`. Jadi one-shot reminder sekarang tidak menghapus sesi live user, dan delivery benar-benar kembali ke session yang sama.
- [O] reminder dari thread/topic mempertahankan return route ke thread/topic yang sama pada job yang dibentuk
  - Alasan audit: setelah rebuild `dist` dan restart gateway aktif, fresh live `chat.send` pada session `agent:main:telegram:group:12345:thread:42` membuat job `03f39e76-f148-4494-bd21-f6796b358aa9` dengan `delivery = { mode: "announce", channel: "telegram", to: "12345", threadId: "42" }`. Jadi routing thread Telegram sekarang benar-benar direhidrasi dari session eksternal, bukan jatuh ke `webchat`.
- [O] reminder `same_chat` dari thread Google Chat yang belum tersedia di runtime aktif sekarang gagal lebih awal dengan penjelasan jelas, bukan dijadwalkan lalu gagal saat run
  - Alasan audit: setelah rebuild `dist` dan restart gateway aktif, fresh live `chat.send --expect-final` pada session `agent:main:googlechat:group:spaces/proof-failfast3:thread:spaces/proof-failfast3/threads/thread-proof` untuk `ingatkan saya 6 detik lagi ... dan balas ke chat ini` sekarang langsung membalas `Pilihan itu belum tersedia untuk permintaan ini... kirim ke channel yang terhubung (telegram), kirim ke webhook, simpan internal saja.` Fresh `chat.history` pada session itu menampilkan balasan fail-fast yang sama, dan fresh `cron.list` tetap `total = 0`, jadi request Google Chat ini tidak lagi membuat job rusak yang baru gagal belakangan. Ini cocok dengan `health` host aktif yang memang hanya memuat Telegram sebagai channel terkonfigurasi.
- [O] URL webhook eksplisit tidak rusak saat diparse
  - Alasan audit: fresh live `chat.send --expect-final` pada session `agent:main:webchat:direct:final-url-20260327` membalas `Siap, saya akan mengirim pengingat lewat webhook dalam 2 menit.` `cron.list` pada gateway aktif juga merekam job `b4c40f96-81d9-4c2e-8575-a12ef5d277e5` dengan `delivery = { mode: "webhook", to: "https://example.com/hook" }`. Jadi URL webhook eksplisit sekarang tetap utuh saat diparse.
- [O] ISO timestamp tidak rusak saat diparse
  - Alasan audit: fresh live `chat.send --expect-final` pada session `agent:main:webchat:direct:final-iso-20260327` untuk `ingatkan saya pada 2026-03-25T17:00:00Z untuk meeting` memang mem-parse `2026-03-25T17:00:00Z` sebagai `schedule.at` absolut yang sama. Gateway aktif lalu menolak permintaan itu karena timestamp tersebut sudah di masa lalu (`schedule.at is in the past`), bukan karena parser rusak. Jadi parsing ISO sekarang benar, walau contoh tanggal ini memang tidak valid untuk dijadwalkan lagi pada tanggal audit saat ini.
- [O] natural time seperti `besok jam 7 pagi` dan `jam 2 malam` sudah terbaca benar
  - Alasan audit: fresh live `chat.send --expect-final` pada session `agent:main:webchat:direct:auto-0328` membalas `Siap, saya akan menjalankan automation sesuai jadwal setiap hari jam 2 malam dan mengirim status di chat ini.` `cron.list` sebelum cleanup merekam job `d3d77e34-afeb-4853-bc0d-efb48346b734` dengan `schedule = { kind: "cron", expr: "0 2 * * *" }`. Fresh live `chat.send --expect-final` pada session `agent:main:webchat:direct:natural-0328` untuk `ingatkan saya besok jam 7 pagi ...` juga membalas `Siap, saya akan mengirim pengingat di chat ini pada 29 Mar 2026, 07.00.` Jadi clock time natural harian dan absolute natural time sama-sama sudah terbaca benar.
- [O] reminder dengan wording berbeda tetapi makna sama tetap masuk jalur deterministic tanpa menambah regex per kalimat
  - Alasan audit: fresh live `chat.send --expect-final` pada session `agent:main:webchat:direct:final-wording-20260327` untuk `chat saya 1 menit lagi untuk saya makan` membalas `Bisa, tetapi saya perlu target pengingatnya terlebih dulu...`. Jadi wording alternatif itu tetap masuk jalur reminder deterministic dan meminta target delivery, bukan jatuh ke model umum.
- [O] reminder berulang tidak lagi salah jatuh ke `periodic_monitoring`
  - Alasan audit: fresh live `chat.send --expect-final` pada session `agent:main:webchat:direct:final-recurring-20260327` untuk `ingatkan saya setiap hari untuk minum obat` membalas `Saya masih perlu waktu pengingat yang jelas dulu...`, bukan flow monitoring. Jadi reminder berulang tanpa jam tetap berada di jalur klarifikasi reminder, bukan salah jatuh ke `periodic_monitoring`.
- [O] isi reminder yang benar-benar terkirim via cron delivery tetap bersih dan tidak memantulkan instruksi delivery
  - Alasan audit: fresh live same-chat reminder pada session `agent:main:webchat:direct:samechat-direct-0328` tampil di `chat.history` sebagai teks bersih `Waktunya samechat-direct-0328!`, dan fresh live configured-channel Telegram juga tampil di `chat.history` target `agent:main:telegram:direct:2081385952` sebagai teks bersih `Pengingat: configured-direct-0328 lewat telegram`. Jadi user-facing reminder yang benar-benar terkirim via cron delivery sekarang tidak lagi memantulkan instruksi internal seperti `Balas dengan tepat teks berikut ...`.
- [O] reminder biasa tetap satu target delivery dan tidak collapse diam-diam ke target yang salah
  - Alasan audit: fresh live `chat.send --expect-final` pada session `agent:main:webchat:direct:final-conflict-20260327` membalas `Saya melihat lebih dari satu target delivery untuk reminder itu (balas ke chat ini, webhook https://example.com/hook). Pilih satu saja.` `cron.list` sesudahnya tetap hanya menampilkan job audit yang memang dibuat oleh session lain (`final-url`, `final-natural`, dan job user yang sudah ada), jadi query konflik ini sendiri tidak membuat job baru.
- [O] scheduled automation memakai dua target yang berbeda: `actionTarget` dan `notifyTarget`
  - Alasan audit: fresh live `chat.send --expect-final` pada session `agent:main:webchat:direct:final-natural-20260327` membuat automation `43e5fa54-06b2-4844-b2f2-e823b8ee0f11` dengan `payload.kind = "httpAction"` dan `payload.request.url = "https://action.example/proof"`, sementara `delivery = { mode: "announce", channel: "webchat", to: "agent:main:webchat:direct:final-natural-20260327" }` tetap terpisah sebagai notify target.
- [O] device action tidak lagi dimodelkan sebagai `delivery.mode = "webhook"`
  - Alasan audit: fresh live automation pada session `agent:main:webchat:direct:final-natural-20260327` memakai `payload.kind = "httpAction"` untuk aksi perangkat, sedangkan `delivery.mode = "announce"` hanya dipakai untuk notifikasi. Jadi aksi device tidak lagi dicampur ke `delivery.mode = "webhook"`.
- [O] list cron via chat memanggil structured list/status, bukan jawab capability saja
  - Alasan audit: fresh live `chat.send --expect-final` pada session `agent:main:webchat:direct:final-list-0328b` untuk `boleh lihat jadwal rutin apa yang aktif sekarang?` mengembalikan daftar bernomor `Daftar job cron aktif:` yang berisi nama, status, jadwal, dan target delivery. Jadi list cron natural via chat sekarang benar-benar memanggil structured list/status, bukan sekadar menjawab capability cron atau salah menganggap tidak ada job.
- [O] update cron via chat benar-benar mengubah job existing, bukan jatuh ke flow create reminder
  - Alasan audit: fresh live session `agent:main:webchat:direct:fix6-update-fresh-20260327` pertama membuat automation `audit-update-fresh-20260327` dengan `payload.request.url = "https://example.com/action-a"`, lalu follow-up update via chat membalas sukses. Fresh `cron.list` sesudahnya menunjukkan job yang sama (`6325b52b-f4d5-4b53-b103-b3430860da0e`) tetap existing tetapi `updatedAtMs` bergerak dari `1774592593739` ke `1774592624769` dan `payload.request.url` berubah menjadi `https://example.com/action-b`. Jadi update sekarang benar-benar memutasi job existing.
- [O] remove cron via chat benar-benar menghapus job existing, bukan jatuh ke flow create reminder
  - Alasan audit: fresh live session `agent:main:webchat:direct:md-remove-20260327` pertama membuat `Reminder: md remove 20260327`, lalu follow-up `hapus reminder saya yang tadi` membalas `Siap, saya akan menghapus job Reminder: md remove 20260327.` `cron.list` sesudahnya kembali kosong untuk query itu, jadi flow remove benar-benar menghapus job existing.
- [O] follow-up mutation seperti `ganti webhook ke ...` benar-benar mengubah target yang sudah ada
  - Alasan audit: fresh live follow-up `ganti webhook ke https://example.com/action-b` pada session `agent:main:webchat:direct:fix6-update-fresh-20260327` dibalas `Siap, saya akan memperbarui job Automation: nyalakan lampu audit-update-fresh-20260327.` Fresh `cron.list` sesudahnya menunjukkan URL target yang sama-sama sudah berubah ke `https://example.com/action-b`, jadi mutation follow-up ini sekarang benar-benar mengubah target existing.
- [O] `configured_channel` tetap didukung sebagai delivery target v1
  - Alasan audit: fresh live session `agent:main:webchat:direct:configured-direct-0328` membalas `Siap, saya akan mengirim pengingat lewat telegram dalam 6 detik.` Fresh `cron.runs` pada gateway aktif lalu mencatat run `2742dcef-e8f0-4e61-a4ed-630aa92c9893` dengan `status = "ok"`, `delivered = true`, dan summary `Pengingat: configured-direct-0328 lewat telegram`. Fresh `chat.history` pada session target `agent:main:telegram:direct:2081385952` juga menampilkan mirror delivery `Pengingat: configured-direct-0328 lewat telegram`. Jadi configured-channel sekarang terbukti end-to-end ke Telegram target pada build terbaru.
- [O] pertanyaan self/runtime singkat tidak lagi lolos ke model umum
  - Alasan audit: fresh live `siapa anda?`, `boleh tahu siapa anda?`, `apa tugas anda?`, `tugas kamu apa?`, `apa peran anda di sini?`, `model apa yang kamu pakai sekarang?`, `model text dan ocr apa yang anda pakai?`, `cron aktif nggak?`, dan `webhook aktif?` semuanya sekarang dijawab deterministic oleh gateway aktif, tanpa jatuh ke model umum.
- [O] jawaban self/runtime membaca sumber kebenaran yang sama dengan runtime efektif
  - Alasan audit: fresh live `siapa anda?` dan `boleh tahu siapa anda?` sama-sama menjawab `Saya Hypatia.`; fresh live `apa tugas anda?`, `tugas kamu apa?`, dan `apa peran anda di sini?` sekarang sama-sama memakai teks role yang sama; fresh live jawaban model/orchestra cocok dengan runtime model aktif; dan fresh live `cron aktif nggak?` / `cron sekarang aktif?` tetap datang dari handler deterministic yang sama walau angka `Total job` memang mengikuti state runtime live saat itu.
- [O] `siapa saya?` hanya membaca canonical active owner facts
  - Alasan audit: fresh live owner write di `agent:main:webchat:direct:cli` menyimpan `name.full = Subagent Cross 20260327` sebagai canonical fact `profile-name.full-5f363e68-0ee4-481d-b795-5a5830bbb0f9.json`, sementara artefak legacy `profile-note.226b4a72-...json` masih tetap ada di fact store. Fresh live read `siapa saya?` dari `agent:main:telegram:direct:2081385952` menjawab `Nama yang saya simpan untuk owner profile ini adalah Subagent Cross 20260327.` Jadi jawaban self-profile tetap mengikuti canonical fact `name.full`, bukan note lama atau retrieval campuran.
- [O] `ingat nama saya ...` tidak lagi jatuh ke `profile.note.<hash>`
  - Alasan audit: fresh live `ingat nama saya, Subagent Owner 20260327` di session `agent:main:telegram:direct:2081385952` menjawab `Tersimpan ke user memory: name.full = Subagent Owner 20260327.` Fact store aktif juga membuat `profile-name.full-c433823b-fb3b-41d6-a6e4-38e1891d72c6.json` dengan `key = "name.full"` dan provenance Telegram, bukan note hash baru.
- [O] owner profile hanya bisa dibaca oleh owner di chat direct
  - Alasan audit: fresh live `siapa saya?` di `agent:main:telegram:direct:2081385952` menjawab sukses dengan nilai owner profile canonical (`Subagent Cross 20260327` setelah write lintas `webchat:cli`). Jadi proof positif read-owner-direct sekarang benar-benar ada di gateway aktif.
- [O] owner profile hanya bisa ditulis oleh owner di chat direct
  - Alasan audit: fresh live `ingat nama saya, Subagent Owner 20260327` di `agent:main:telegram:direct:2081385952` diterima dan membuat typed fact `name.full` dengan provenance Telegram; pada saat yang sama group owner dan non-owner direct/group tetap ditolak. Jadi proof positif write-owner-direct sekarang ada dan konsisten dengan gate-nya.
- [O] owner di group tidak bisa read/write owner profile
  - Alasan audit: fresh live `siapa saya?` dan write owner-profile di `agent:main:telegram:group:owner-group-proof-20260327` sama-sama ditolak dengan balasan `Owner profile hanya bisa dibaca/ditulis oleh owner dari chat direct.` Jadi gate group-deny sekarang terbukti lagi pada gateway aktif.
- [O] non-owner di direct atau group tidak bisa read/write owner profile
  - Alasan audit: setelah patch memory-owner gating, live `chat.send --expect-final` di gateway aktif sekarang menolak `siapa saya?`, `ingat nama saya ...`, dan bypass eksplisit `memory_search Typed Check` untuk session non-owner direct maupun group; `chat.history` hanya menyimpan balasan penolakan, dan fact store aktif tidak memuat value baru dari write yang diblok.
- [O] lintas channel owner tetap menulis ke satu owner profile yang sama secara sengaja
  - Alasan audit: fresh live owner write di `agent:main:webchat:direct:cli` menyimpan `editor.favorite = Fix6PrefWeb 20260327`, lalu fresh live owner write di `agent:main:telegram:direct:2081385952` menyimpan `editor.favorite = Fix6PrefTele 20260327`. Fact store aktif sesudahnya menunjukkan record webchat `preferences-editor.favorite-10b559f8-1e51-423f-a25b-16f3b3ac0d1e.json` berubah menjadi `superseded`, sedangkan hanya satu record yang tersisa `active`, yaitu `preferences-editor.favorite-693136b9-6fdd-450e-a56f-3f75ba1fe5bf.json` dengan provenance Telegram. Jadi lintas channel owner sekarang benar-benar merge ke satu canonical active record, bukan collision ganda yang sama-sama aktif.
- [O] sender/provider provenance tetap tersimpan, tetapi audit-only
  - Alasan audit: fact store aktif masih menyimpan provenance pada canonical owner fact `profile-name.full-5f363e68-0ee4-481d-b795-5a5830bbb0f9.json` dengan `provider = webchat` dan `senderId = cli`, tetapi fresh live owner-direct `siapa saya?` hanya menjawab nama owner (`Subagent Cross 20260327`) tanpa membocorkan provenance tersebut ke user.
- [O] self-profile tidak lagi bergantung pada sender-hint retrieval
  - Alasan audit: fresh live write owner-profile dari sender `webchat:cli` lalu fresh live read dari sender Telegram `2081385952` tetap mengembalikan nilai canonical yang sama (`Subagent Cross 20260327`). Saya juga menguji preference merge lintas channel (`TeleMergeLive-...` lalu `WebMergeLive-...`), dan read Telegram direct selalu mengikuti fact aktif terbaru. Jadi hasil self-profile/read owner-profile tidak lagi terkunci ke sender-hint asal penulisannya.
- [O] history/docs/memory yang unavailable atau scope-limited tidak lagi tampil menyesatkan sebagai `no matches`
  - Alasan audit: fresh live cross-session history probe pada session `agent:main:webchat:direct:scope-proof-b` untuk `apa yang tadi saya bilang soal scope-proof-0328-xyz?` sekarang dijawab deterministic sebagai `Saat ini saya belum bisa membaca history karena backend RAG sedang tidak siap.`, bukan `no matches`. Pada build ini, jalur unavailable/scope-limited sudah memberikan error domain yang jujur dan deterministic, jadi user tidak lagi mendapat kesan palsu bahwa data tidak ada padahal backend/domain-nya yang tidak siap.
- [O] domain `docs_kb`, `history`, dan `memory` tidak lagi runtuh ke jalur generik yang sama tanpa kejelasan
  - Alasan audit: fresh live probe pada session `agent:main:webchat:direct:last-domain-0327` tetap membedakan tiga domain dengan jawaban yang jelas berbeda: `siapa saya?` -> deny owner-profile (`memory`), `cari docs OpenClaw tentang gateway token` -> knowledge-store unreachable (`docs_kb`), dan `apa yang tadi saya bilang soal scope-proof-0327-xyz?` -> history-store unreachable (`history`). Jadi walau backend retrieval sedang bermasalah, tiga domain ini tetap tidak runtuh ke satu respons generik yang sama.
- [O] private/LAN endpoint untuk automation tetap aman by default dan hanya lolos lewat allowlist eksplisit
  - Alasan audit: fresh live `chat.send --expect-final` pada session `agent:main:webchat:direct:final-lan-20260327` membalas `Saya gagal menjadwalkan permintaan itu: cron httpAction target is blocked by SSRF policy...` untuk target `http://192.168.1.2/hook`. `cron.list` sesudahnya tidak membuat job baru untuk session `final-lan-20260327`. Jadi target private/LAN sekarang memang diblok default.
- [O] regression tests mencakup reminder, automation, cron management, lintas channel, dan owner memory policy
  - Alasan audit: setelah fix live di gateway aktif, scoped regression suites yang menyentuh surface yang sama juga lulus: `src/auto-reply/scheduling-intent.test.ts`, `src/gateway/server-methods/chat.directive-tags.test.ts`, `src/auto-reply/memory-recall.test.ts`, `src/auto-reply/memory-save.test.ts`, dan `src/auto-reply/command-auth.owner-default.test.ts`. Jadi checklist ini sekarang tidak hanya punya proof live, tetapi juga regression coverage yang relevan.
- [O] `self-facts`, `memory-save`, `memory-recall`, dan `scheduling-intent` deterministic memang berasal dari fork/workspace ini, bukan baseline `upstream/main`
  - Alasan audit: code-audit terhadap `upstream/main` menunjukkan file `src/auto-reply/self-facts.ts` dan `src/auto-reply/memory-save.ts` bahkan tidak ada di upstream, dan `git diff --stat upstream/main` menunjukkan penambahan besar untuk deterministic NL layer ini di fork.
- [O] upstream menangani natural-language lebih model-driven daripada fork ini
  - Alasan audit: upstream `src/auto-reply/reply/get-reply-run.ts` tidak memanggil front-door deterministic surfaces seperti `self-facts`, `memory-save`, `memory-recall`, dan `scheduling-intent`; sementara upstream `src/agents/system-prompt.ts:44-53` mendorong memory recall lewat `memory_search` / `memory_get`.
- [O] routing utama reminder/cron sekarang memakai semantic-concept/slot matching untuk cluster yang didukung; regex tersisa hanya untuk ekstraksi waktu, URL, dan cleanup teknis low-level
  - Alasan audit: code-audit pada `src/auto-reply/scheduling-intent.ts` sekarang menunjukkan routing utama reminder/cron dan delivery selection sudah lewat `SCHEDULING_SEMANTIC_LEXICON`, `tokenizeSchedulingSemantics`, serta helper seperti `looksLikeReminderIntent`, `looksLikeCronListQuery`, `looksLikeCronUpdateQuery`, `detectDirectDeliveryResolution`, dan `buildCronMutationLookupQuery`, dengan alias multi-kata untuk `reply here`, `balas ke chat ini`, `internal saja`, `show me all active schedules right now`, dan phrasing sejenis. Regex yang tersisa sekarang memang terbatas pada primitive teknis seperti waktu (`RELATIVE_TIME_RE`, `NATURAL_CLOCK_RE`, `ABSOLUTE_TIME_RE`), URL (`URL_RE`), dan cleanup low-level. Fresh live probe pada gateway aktif juga membuktikan cluster utama ini jalan end-to-end: `remind me in 2 minutes to deploy and reply here` -> create deterministic, `please show me all active schedules right now` -> list deterministic, dan `hapus reminder saya yang tadi` -> remove deterministic, lalu `cron.list` kembali `total = 0` setelah cleanup.
- [O] jalur self/runtime utama sekarang memakai semantic-concept routing yang sama untuk cluster pertanyaan yang didukung
  - Alasan audit: code-audit pada `src/auto-reply/self-facts.ts` sekarang menunjukkan routing lewat `SELF_SEMANTIC_LEXICON`, `tokenizeSelfSemantics`, dan `detectSelfIntent`, dengan dukungan alias multi-kata untuk phrasing seperti `what do you do`, `boleh tahu siapa anda`, `apa peran anda di sini`, `model text dan ocr apa yang anda pakai`, dan status capability pendek. Fresh live probe di gateway aktif juga membuktikan cluster ini converge ke jawaban canonical yang sama: `what do you do here?` dan `tugas kamu apa?` sama-sama menjawab role canonical, sementara `boleh tahu siapa anda?`, `webhook aktif?`, dan `cron aktif nggak?` tetap deterministic tanpa jatuh ke model umum.
- [O] jalur owner-memory write utama sekarang memakai semantic-concept extraction untuk field typed utama, bukan phrase-list exact per kalimat
  - Alasan audit: code-audit pada `src/auto-reply/memory-save.ts` sekarang menunjukkan owner-profile write utama sudah bergerak ke `OWNER_PROFILE_SEMANTIC_LEXICON`, `tokenizeOwnerProfileSemantics`, `extractSemanticValue`, `extractSemanticPreferredName`, dan semantic intent gating untuk `name.full`, `nickname`, serta reference field utama. Cue/phrase matcher masih tersisa di file ini, tetapi sekarang dipakai untuk jalur docs-save/ambiguous-save dan fallback generic note, bukan sebagai decision engine utama owner-profile write. Fresh live probe di gateway aktif juga membuktikan paraphrase utama sudah converge ke key typed yang sama: `my name is Dynamic Semantic 0328` -> `name.full`, lalu read `siapa saya?` mengembalikan canonical owner fact `Dynamic Semantic 0328` setelah write tersebut selesai.
- [O] untuk cluster self/runtime yang sudah ditangani, paraphrase utama sekarang converge ke jawaban canonical yang sama
  - Alasan audit: fresh live `apa tugas anda?`, `tugas kamu apa?`, dan `apa peran anda di sini?` sekarang sama-sama menghasilkan jawaban role yang sama di gateway aktif; ini juga diperkuat oleh resolver tunggal di `src/auto-reply/self-facts.ts:192-198`, `src/auto-reply/self-facts.ts:315-317`, dan `src/auto-reply/self-facts.ts:356-360`.
