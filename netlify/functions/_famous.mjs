// Famous bands: the Daily Chain's "people have heard of these" list.
//
// WHY THIS EXISTS (Cole/Paul, 2026-10-08)
//
// The daily pair used to be drawn uniformly from ~2,300 connected bands, so
// most days were "The Flowers of Romance → Giraffe Tongue Orchestra". New
// players bounced: not knowing ANY of the bands isn't a puzzle, it's a wall.
// The database has no popularity signal (connection count tracks supergroups
// like Pigface, not fame), so fame is a hand-kept list.
//
// The daily deal picks both ends from HEADLINER_BANDS (below) and requires
// a shortest route that runs through this list only; the multiple-choice
// slate puts listed bands first. Names match `bands.name` case-insensitively; names not
// in the database are simply ignored, so adding a band here is always safe.
// Measured 2026-10-08: ~145 of these are in the graph, giving ~1,000
// all-famous pairs at 3–4 hops — years of dailies under the 90-day quarantine.

export const FAMOUS_BANDS = [
  // Seattle and grunge
  'Nirvana', 'Foo Fighters', 'Pearl Jam', 'Soundgarden', 'Alice in Chains', 'Mudhoney',
  'Screaming Trees', 'Mother Love Bone', 'Green River', 'Temple of the Dog', 'Mad Season',
  'Audioslave', 'Melvins', 'Heart', 'Modest Mouse', 'Death Cab for Cutie', 'The Shins',
  'Band of Horses', 'Fleet Foxes', 'Sleater-Kinney', 'Built to Spill', 'Candlebox', 'Hole',
  // Stoner, alt-metal and the 90s
  'Queens of the Stone Age', 'Them Crooked Vultures', 'Kyuss', 'Eagles of Death Metal',
  'Rage Against the Machine', 'Red Hot Chili Peppers', "Jane's Addiction", 'Porno for Pyros',
  'Velvet Revolver', 'Stone Temple Pilots', 'Faith No More', 'Primus', 'Tool', 'A Perfect Circle',
  'Puscifer', 'Nine Inch Nails', 'Ministry', 'Deftones', 'Korn', 'Incubus', 'Creed', 'Alter Bridge',
  'Bush', 'Live', 'Collective Soul', 'Toadies', 'Garbage', 'Weezer', 'Green Day', 'Smashing Pumpkins',
  // Metal
  'Metallica', 'Megadeth', 'Slayer', 'Anthrax', 'Black Sabbath', 'Ozzy Osbourne', 'Dio', 'Rainbow',
  'Iron Maiden', 'Judas Priest', 'Motörhead', 'Pantera', 'Down', 'Slipknot', 'Stone Sour',
  'Mastodon', 'Gojira', 'Sepultura', 'Soulfly', 'Cavalera Conspiracy', 'Testament', 'Exodus',
  'Suicidal Tendencies', 'Infectious Grooves', 'Fear Factory', 'Dream Theater', 'Scorpions',
  'Thin Lizzy', 'UFO', 'Accept',
  // Hard rock and arena rock
  "Guns N' Roses", 'AC/DC', 'Led Zeppelin', 'Deep Purple', 'Whitesnake', 'Van Halen', 'Kiss',
  'Aerosmith', 'Mötley Crüe', 'Def Leppard', 'Journey', 'Toto', 'Foreigner', 'Boston', 'Styx',
  'REO Speedwagon', 'Kansas', 'Bad Company', 'Free', 'Lynyrd Skynyrd', 'ZZ Top',
  // Classic rock
  'The Beatles', 'The Rolling Stones', 'The Who', 'The Kinks', 'Cream', 'Blind Faith',
  'Derek and the Dominos', 'The Yardbirds', 'Traffic', 'Fleetwood Mac', 'Eagles', 'Wings',
  'Traveling Wilburys', 'Electric Light Orchestra', 'The Allman Brothers Band', 'Grateful Dead',
  'Crosby, Stills, Nash & Young', 'Buffalo Springfield', 'The Byrds', 'Santana', 'The Doors',
  'Pink Floyd', 'Genesis', 'Yes', 'King Crimson', 'Asia', 'Emerson, Lake & Palmer', 'Rush',
  'Queen', 'David Bowie', 'The Velvet Underground',
  // Punk, post-punk and new wave
  'The Clash', 'Sex Pistols', 'Ramones', 'The Damned', 'Buzzcocks', 'Dead Kennedys', 'Black Flag',
  'Bad Religion', 'Social Distortion', 'Misfits', 'Danzig', 'Public Image Ltd', 'Siouxsie and the Banshees',
  'Joy Division', 'New Order', 'The Cure', 'Bauhaus', 'Killing Joke', 'The Police', 'Talking Heads',
  'Blondie', 'Devo', 'The Pretenders', 'The Smiths', 'Duran Duran', 'Simple Minds', 'U2',
  // Alternative and indie
  'R.E.M.', 'Pixies', 'The Breeders', 'Sonic Youth', 'Dinosaur Jr.', 'Hüsker Dü', 'The Replacements',
  'Soul Asylum', 'Wilco', 'Oasis', 'Blur', 'Gorillaz', 'Radiohead', 'Muse', 'Coldplay', 'Supergrass',
  'The White Stripes', 'The Strokes', 'Arctic Monkeys', 'The Black Keys',
];

// Headliners: household names. Each day's start and target come from here;
// the wider list above still covers the bands in between and the choices.
export const HEADLINER_BANDS = [
  'Nirvana', 'Foo Fighters', 'Pearl Jam', 'Soundgarden', 'Alice in Chains', 'Heart', 'Audioslave',
  'Queens of the Stone Age', 'Rage Against the Machine', 'Red Hot Chili Peppers', "Jane's Addiction",
  'Velvet Revolver', 'Stone Temple Pilots', 'Tool', 'Nine Inch Nails', 'Weezer', 'Green Day',
  'Smashing Pumpkins', 'Metallica', 'Megadeth', 'Slayer', 'Black Sabbath', 'Ozzy Osbourne', 'Iron Maiden',
  'Judas Priest', 'Motörhead', 'Pantera', 'Slipknot', "Guns N' Roses", 'AC/DC', 'Led Zeppelin',
  'Deep Purple', 'Whitesnake', 'Van Halen', 'Kiss', 'Aerosmith', 'Mötley Crüe', 'Def Leppard', 'Journey',
  'Toto', 'Foreigner', 'Boston', 'Lynyrd Skynyrd', 'ZZ Top', 'The Beatles', 'The Rolling Stones', 'The Who',
  'Cream', 'Fleetwood Mac', 'Eagles', 'Wings', 'Traveling Wilburys', 'Grateful Dead', 'Santana',
  'The Doors', 'Pink Floyd', 'Genesis', 'Yes', 'Rush', 'Queen', 'David Bowie', 'The Clash', 'Sex Pistols',
  'Ramones', 'The Police', 'Talking Heads', 'Blondie', 'The Cure', 'Duran Duran', 'U2', 'R.E.M.',
  'Pixies', 'Sonic Youth', 'Oasis', 'Blur', 'Gorillaz', 'Radiohead', 'Coldplay', 'The White Stripes',
  'The Strokes', 'Arctic Monkeys', 'The Black Keys', 'Modest Mouse', 'Death Cab for Cutie', 'Wilco',
];

// Ids of listed bands that exist in the graph and have at least one link.
export function famousIdsFrom(meta, adj, names = FAMOUS_BANDS) {
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  const ids = new Set();
  for (const [id, m] of meta) {
    if (m && m.name && wanted.has(String(m.name).toLowerCase()) && adj.has(id)) ids.add(id);
  }
  return ids;
}
