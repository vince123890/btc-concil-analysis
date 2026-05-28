# BTC Bandarmology Intelligence v5 · Agent Council Edition

Live BTC trading dashboard dengan **multi-agent council** — terinspirasi framework TradingAgents (Tauric Research). Bukan satu AI call, tapi tim agent yang berdebat untuk keputusan LONG/SHORT/WAIT yang lebih robust.

## Inti v5 — kenapa multi-agent lebih akurat

Versi sebelumnya: satu Gemini call membaca semua data → langsung keputusan. Risiko: **anchoring bias** — model bisa "jatuh cinta" pada satu narasi dan abaikan sinyal lawan.

v5 meniru cara trading desk profesional bekerja:

```
                 ┌──────────────┐
  snapshot ─────▶│  Bull Agent  │──┐  (bangun kasus LONG terkuat)
      │          └──────────────┘  │
      │          ┌──────────────┐  ├──▶ Research Manager ──▶ Portfolio Manager ──▶ LONG/SHORT/WAIT
      └─────────▶│  Bear Agent  │──┘   (timbang bukti        (risk lens +          (+ debate transcript)
                 └──────────────┘       objektif)             keputusan final)
   (paralel)
```

Setiap agent = 1 Gemini call dengan peran spesifik:

1. **Bull Researcher** — dipaksa bangun argumen LONG terkuat, cite data, akui & rebut risiko
2. **Bear Researcher** — dipaksa bangun argumen SHORT/AVOID terkuat (jalan paralel dengan Bull)
3. **Research Manager (Judge)** — timbang kedua argumen secara objektif → lean (BULLISH/BEARISH/NEUTRAL) + conviction 0-100 + faktor penentu
4. **Portfolio Manager** — terapkan risk lens (aggressive/conservative/neutral) → keputusan final + trade plan lengkap

Karena Bull & Bear membangun kasus **secara independen** sebelum dihakimi, kedua sisi mendapat representasi penuh. Judge melihat argumen lengkap keduanya, bukan satu narasi yang sudah bias.

## Dua mode (toggle di Settings)

| Mode | Cara kerja | Latency | Kuota | Kapan pakai |
|---|---|---|---|---|
| **⚖ Agent Council** (default) | 4 AI call (Bull‖Bear → Judge → PM) | ~30-50s | 4× | Keputusan penting, mau lihat reasoning lengkap |
| **⚡ Quick Analysis** | 1 AI call (seperti v4) | ~12-18s | 1× | Cek cepat, hemat kuota |

Mode tersimpan di localStorage. Bisa ganti kapan saja.

## Tampilan baru — Debate Transcript

Setelah council selesai, muncul kartu **"Agent Council Debate"** yang menampilkan:
- **Argumen Bull** (border hijau) — kasus LONG penuh
- **Argumen Bear** (border merah) — kasus SHORT penuh
- **Verdict Research Manager** — lean + conviction bar + faktor penentu + invalidation

Ini membuat keputusan **transparan** — kamu bisa lihat persis kenapa AI memutuskan LONG/SHORT/WAIT, bukan black box.

Saat council berjalan, ada **stepper progress** real-time menunjukkan agent mana yang sedang bekerja (Debate → Judge → Final).

## Output schema (council)

Sama seperti v4 (semua field trade plan + derivatives/technical/options/onchain/macro view + cycleStage), PLUS:

```json
{
  // ... semua field v4 ...
  "debate": {
    "bullCase": "Argumen lengkap bull researcher...",
    "bearCase": "Argumen lengkap bear researcher...",
    "judge": {
      "lean": "BULLISH",
      "conviction": 72,
      "decidingFactors": ["OI +3.4% konfirmasi", "smart money long 1.85", "3 TF aligned"],
      "invalidation": "Break di bawah $66k dengan OI naik",
      "summary": "..."
    }
  }
}
```

## Apa yang dipinjam dari TradingAgents

| TradingAgents (Python, LangGraph) | v5 (browser, Gemini) |
|---|---|
| 4 Analyst (fundamentals/sentiment/news/technical) | Data sudah di-precompute di snapshot, jadi tidak perlu agent terpisah |
| Bull vs Bear researcher debate | ✓ Diadaptasi — Bull & Bear paralel |
| Research Manager judge | ✓ Diadaptasi — judge dengan conviction score |
| Trader proposal | Digabung ke Portfolio Manager |
| Risk debate (aggressive/conservative/neutral) | ✓ Diadaptasi — sebagai "risk lens" di prompt PM (3 sudut pandang internal) |
| Portfolio Manager final | ✓ Diadaptasi — keputusan final terstruktur |
| Memory/reflection | (belum — kandidat v6) |

Penyesuaian dibuat karena:
- Browser tidak bisa jalankan LangGraph/Python
- Untuk hemat latency & kuota, risk debate digabung jadi satu PM call dengan 3 sudut pandang internal (bukan 3 call terpisah)
- Data analyst layer sudah jadi snapshot pre-computed, tidak perlu agent gathering

## Token & cost budget (council)

| Agent | Input token (est) | Call |
|---|---|---|
| Bull | ~684 | 1 |
| Bear | ~684 | 1 (paralel dgn Bull) |
| Judge | ~702 | 1 |
| Final PM | ~826 | 1 |
| **Total** | **~2900 input** | **4 call** |

Dengan Gemini 2.5 Flash (~$0.001/call) → council run ≈ **$0.004**. Free tier 1500 req/hari → ~375 council run/hari. Lebih dari cukup.

## File Structure

```
btc-bandarmology/
├── api/
│   └── snapshot.js       ← sama seperti v4 (19 endpoint)
├── index.html
├── app.js                ← v5: buildDataSection refactor + council pipeline + debate UI
├── vercel.json
├── README.md
└── .gitignore
```

## Deploy

Vercel Import → Framework: **Other** → Deploy. Tidak ada env var baru. Gemini key (BYOK) sama seperti sebelumnya.

Default mode = Council. User bisa switch ke Quick di Settings kalau mau cepat/hemat kuota.

## Catatan akurasi

Multi-agent debate secara empiris (per paper TradingAgents, arXiv 2412.20138) menghasilkan keputusan lebih robust karena adversarial reasoning menangkap blind spot. Tapi: **tetap bukan jaminan profit**. AI bisa salah, data bisa lagging, market bisa irasional. Selalu DYOR & risk management.

## Roadmap v6 (kandidat)

- **Memory/reflection**: simpan keputusan + outcome, AI belajar dari hasil masa lalu (seperti TradingMemoryLog di TradingAgents)
- **Configurable debate rounds**: 2-3 ronde bolak-balik Bull↔Bear
- **Separate risk debate**: 3 call terpisah aggressive/conservative/neutral untuk yang mau maksimal

## Disclaimer

Bukan saran finansial. DYOR. Trading crypto berisiko tinggi.
