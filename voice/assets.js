'use strict';
// Data files only. The CLI verifies the exact bytes before they become servable.
// Versioned names also distinguish model versions in Vosk's browser cache.
const blob = (repo, sha) => `https://api.github.com/repos/${repo}/git/blobs/${sha}`;
const voices = 'associationconsonne/FliteVoices';
module.exports = [
  { lang: 'en', kind: 'input', file: 'vosk-small-en-in-0.4.tar.gz', bytes: 37561269,
    url: blob('ccoreilly/vosk-browser', '7c9709ee5e5b45faf6c715573b9ff0fe9e1b29f3'),
    sha256: '9baa24e2049fba77164fdf01a538b59d49102efbf980d240431b8c4a91f1cc8d' },
  { lang: 'en', kind: 'output', file: 'cmu-us-ksp-2014.flitevox', bytes: 24954163,
    url: blob(voices, '04d66ccd0a486149ae4d928fc138182d2fcfbbb4'),
    sha256: '5a9ee932cff8d16ef883186f4dab7fc167fb5763bbf7a040b9eee1f741b2aecb' },
  { lang: 'hi', kind: 'input', file: 'vosk-small-hi-0.22.tar.gz', bytes: 44458327,
    url: 'https://codeload.github.com/factfilter0-coder/vosk-model-hindi/tar.gz/4431efa5f66d086e3aec5c2634f988e2b55d147d',
    sha256: '8fc5da89de127a47bd0a8c2a7a73eea561519e8cd07fc3381af95fda29102371' },
  { lang: 'hi', kind: 'output', file: 'cmu-indic-hin-ab-2017.flitevox', bytes: 30897320,
    url: blob(voices, '4963a08c77502c5ae5cb6e4b3a04ba98c449d00f'),
    sha256: '4be49f3da1c46c32f155d74974c73bcf10ffd91ec508c74210274fc074cf60ad' },
];
