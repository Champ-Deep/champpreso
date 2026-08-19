# Changelog

## [0.1.8](https://github.com/Champ-Deep/champpreso/compare/autopreso-v0.1.7...autopreso-v0.1.8) (2026-08-19)


### Features

* add POST /api/session/review for decisions + summary extraction ([68c1fa8](https://github.com/Champ-Deep/champpreso/commit/68c1fa881bcd266b171c00efed9684a0e39fdddd))
* add POST /api/session/seed for one-shot canvas seeding ([f60a1b7](https://github.com/Champ-Deep/champpreso/commit/f60a1b7a1981fca324a40e1294e6017875846afa))
* add session-intent template chips to the Setup screen ([17a1a66](https://github.com/Champ-Deep/champpreso/commit/17a1a66a4085d532e1ff8797206977dcd2c4f5ac))
* ask the board - a Q&A agent with a structural read of the canvas, plus Groq LPU transcription ([fbdc154](https://github.com/Champ-Deep/champpreso/commit/fbdc154edc8cbc56207058455405bfa1a18477ba))
* brainstorm starter templates that seed the canvas with zone layouts ([3ef8f4b](https://github.com/Champ-Deep/champpreso/commit/3ef8f4bc6accad8be3fd8f777be8923c8f6c50d5))
* broadcast agent turn events and add live transcript history ([161ac67](https://github.com/Champ-Deep/champpreso/commit/161ac6741521301c40df1a9f54e50f5203644c13))
* broadcast nudge:failed so the UI never has to guess a steer's outcome ([41cb14a](https://github.com/Champ-Deep/champpreso/commit/41cb14ac4cbd48c89aa092926ce33a720600da45))
* carryover and save-as-template helpers for the brainstorm canvas ([e04ee1b](https://github.com/Champ-Deep/champpreso/commit/e04ee1b0b446201e815854367d80a92ef83fd903))
* default OpenRouter agent model to deepseek/deepseek-v4-flash ([1ed136a](https://github.com/Champ-Deep/champpreso/commit/1ed136a157d4dcee38bd8add18e452ab6c659e61))
* disk-persist canvas state + UI cleanup for dead presentation chrome ([898ceec](https://github.com/Champ-Deep/champpreso/commit/898ceec1e0698df1cda81371dc8e7319214f4bf8))
* merge Aegis design tokens into style.css, remove legacy CSS patches ([20a9cfa](https://github.com/Champ-Deep/champpreso/commit/20a9cfa942b5a6a61697305968828f519123f41c))
* model pickers read the live provider catalog instead of a hardcoded list ([852dea0](https://github.com/Champ-Deep/champpreso/commit/852dea0fe47b3fbd0de42c229f8d7ae7e4adf705))
* re-wire typed-turn and interrupt controls into the halo listening screen ([f916e97](https://github.com/Champ-Deep/champpreso/commit/f916e97a4e4e8c774a5b3a67f84513b8ce2019af))
* real Listening/Paused screen matching the redesign (halo layout) ([2888c26](https://github.com/Champ-Deep/champpreso/commit/2888c26430814a640cb3fd8f920eaa56d7b972a1))
* real Review screen matching the redesign ([a575bea](https://github.com/Champ-Deep/champpreso/commit/a575beadef0bcedb98a91b6face578d07cbcebbe))
* real Setup screen matching the redesign ([ad16c61](https://github.com/Champ-Deep/champpreso/commit/ad16c618f40b07c13444d1427255848853cbe6a7))
* scoped editing backend — edit only drag-selected elements ([ec778b8](https://github.com/Champ-Deep/champpreso/commit/ec778b83976369cb175095c50b6923b2b00aa694))
* scoped-edit UI — selection bar to edit only the selected elements ([83f27a9](https://github.com/Champ-Deep/champpreso/commit/83f27a9b7eed1c4a151f537b3ef3263aa6e7a35d))
* show per-turn latency in the Live Transcript History ([390f680](https://github.com/Champ-Deep/champpreso/commit/390f68030e239e709049113da6122379f9f7cbda))
* silently re-warm the agent when session intent changes pre-session ([256be68](https://github.com/Champ-Deep/champpreso/commit/256be687ad467175894ed9472d7c72f444e12adb))
* typed turns — capture ideas into diagrams without voice ([e29e40a](https://github.com/Champ-Deep/champpreso/commit/e29e40aec33dbc48a67d2fc232064ef77ba2ee2d))
* warm the whiteboard agent on server boot ([dbf78b9](https://github.com/Champ-Deep/champpreso/commit/dbf78b97f60f31e0a26e091f3c88fea8b6d7539a))


### Bug Fixes

* cancel stale boot warmup before starting the real session's loop ([8b22e56](https://github.com/Champ-Deep/champpreso/commit/8b22e565d12ea8514073e4f202941bd40c49395c))
* center the Setup canvas hint within the visible area, not the full window ([e541cf0](https://github.com/Champ-Deep/champpreso/commit/e541cf0307f88bf4243c82bc5db9263f06c42c0d))
* guard stale re-warm timer from clobbering a live session ([e9eedc2](https://github.com/Champ-Deep/champpreso/commit/e9eedc2dffa47bb2bf04a06055d3d7ccfce86275))
* keep the server listening when the STT provider fails to initialize ([d6761d7](https://github.com/Champ-Deep/champpreso/commit/d6761d719ddfffc874afc378f44f6c0349fb4701))
* make WS mode wire rename additive, keep raw mode value ([d44e548](https://github.com/Champ-Deep/champpreso/commit/d44e54852791f3fe715e9441211b9f965ea58b8a))
* move multiSpeaker default to top-level DEFAULT_SETTINGS ([824baf6](https://github.com/Champ-Deep/champpreso/commit/824baf6e894ee19e9a1872c699e9f25a28acdfd3))
* patch ws, qs and body-parser advisories ([bf2ad88](https://github.com/Champ-Deep/champpreso/commit/bf2ad88d92af12a7fd6e08d956fc6fa7a25a0519))
* recompute scoped-edit line numbers at turn execution, not request time ([9703f33](https://github.com/Champ-Deep/champpreso/commit/9703f33c9b8fc1872bc87c116d1e55dc8c6daa2d))
* remove dead .shell two-column grid leftover, causing a blank 360px strip ([2898adf](https://github.com/Champ-Deep/champpreso/commit/2898adf039385e116d9d48588ebfd8a7bd196ea6))
* restore Pin capability and add agent base-URL/reasoning to settings ([ae05de1](https://github.com/Champ-Deep/champpreso/commit/ae05de105dc9d982ca119863bc6ba982d2acf827))
* steer nudges as role:user instead of role:system ([defce12](https://github.com/Champ-Deep/champpreso/commit/defce12e480d429690ad484b4c1ecb32f308a31e))
* stop orphaned MediaStream tracks when mic-capture setup throws ([5555e4d](https://github.com/Champ-Deep/champpreso/commit/5555e4def97aff2f054231296734fabd9028bf9a))
* three real Setup-screen bugs found by manual testing ([25216cd](https://github.com/Champ-Deep/champpreso/commit/25216cd5e5eacecb3944ba3f38fe5b0e3abd2fe5))


### Performance Improvements

* cap first-turn warmup wait and record per-turn latency ([a414f57](https://github.com/Champ-Deep/champpreso/commit/a414f57f185d0f0692720e19925a7775759cf124))

## [0.1.7](https://github.com/kunchenguid/autopreso/compare/autopreso-v0.1.6...autopreso-v0.1.7) (2026-05-21)


### Features

* toggle the settings panel to free up canvas space ([#21](https://github.com/kunchenguid/autopreso/issues/21)) ([fbe5dd6](https://github.com/kunchenguid/autopreso/commit/fbe5dd6029644210f65671ebf305cd4231ab5f96))

## [0.1.6](https://github.com/kunchenguid/autopreso/compare/autopreso-v0.1.5...autopreso-v0.1.6) (2026-05-10)


### Features

* support configurable OpenAI base URLs ([#19](https://github.com/kunchenguid/autopreso/issues/19)) ([3f465c8](https://github.com/kunchenguid/autopreso/commit/3f465c864c442f091128e2b6a4e77394e34e1c37))

## [0.1.5](https://github.com/kunchenguid/autopreso/compare/autopreso-v0.1.4...autopreso-v0.1.5) (2026-05-09)


### Features

* add session cost tracking ([#16](https://github.com/kunchenguid/autopreso/issues/16)) ([5341526](https://github.com/kunchenguid/autopreso/commit/5341526ffbfcb6beb6b197c938a3013166b67c71))

## [0.1.4](https://github.com/kunchenguid/autopreso/compare/autopreso-v0.1.3...autopreso-v0.1.4) (2026-05-09)


### Features

* add persistent agent instructions ([#13](https://github.com/kunchenguid/autopreso/issues/13)) ([41fbd58](https://github.com/kunchenguid/autopreso/commit/41fbd5871ffbced6496ccb0d600d9d2a09a8ab59))
* **transcription:** bias OpenAI transcription with staging vocabulary ([#12](https://github.com/kunchenguid/autopreso/issues/12)) ([6ac7a10](https://github.com/kunchenguid/autopreso/commit/6ac7a1034def51e56ee8ef49cf145944739bcd68))

## [0.1.3](https://github.com/kunchenguid/autopreso/compare/autopreso-v0.1.2...autopreso-v0.1.3) (2026-05-08)


### Bug Fixes

* polish UI controls and logging ([#7](https://github.com/kunchenguid/autopreso/issues/7)) ([588548f](https://github.com/kunchenguid/autopreso/commit/588548f2e91c72030183ddc1aec67f5827b0b720))

## [0.1.2](https://github.com/kunchenguid/autopreso/compare/autopreso-v0.1.1...autopreso-v0.1.2) (2026-05-08)


### Performance Improvements

* reduce screenshot token usage ([#5](https://github.com/kunchenguid/autopreso/issues/5)) ([3e67f4b](https://github.com/kunchenguid/autopreso/commit/3e67f4b3e63eca2ceb9b662c7b3789c72e61326d))

## 0.1.1 (2026-05-08)

Initial public release.
