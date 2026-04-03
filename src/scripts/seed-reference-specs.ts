import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

/**
 * Seed the aircraft_reference_specs table with performance data
 * for common UL/LSA/microlight aircraft using Claude Haiku AI.
 *
 * Usage: npx tsx src/scripts/seed-reference-specs.ts
 */

const MODELS = [
  // ===== ULTRALIGHT / LSA / MICROLIGHT =====
  // Dynamic / Aerospool
  { manufacturer: "Dynamic", model: "WT-9", variant: "Dynamic" },
  { manufacturer: "Dynamic", model: "WT-9", variant: "Dynamic Club" },
  // Comco Ikarus
  { manufacturer: "Comco Ikarus", model: "C42", variant: "B" },
  { manufacturer: "Comco Ikarus", model: "C42", variant: "C" },
  { manufacturer: "Comco Ikarus", model: "C22", variant: null },
  // Flight Design
  { manufacturer: "Flight Design", model: "CT", variant: "CTLS" },
  { manufacturer: "Flight Design", model: "CT", variant: "CTSW" },
  { manufacturer: "Flight Design", model: "CT", variant: "CTLSi" },
  { manufacturer: "Flight Design", model: "F2", variant: null },
  // Pipistrel / Textron eAviation
  { manufacturer: "Pipistrel", model: "Virus", variant: "SW 121" },
  { manufacturer: "Pipistrel", model: "Virus", variant: "SW 80" },
  { manufacturer: "Pipistrel", model: "Sinus", variant: "912" },
  { manufacturer: "Pipistrel", model: "Alpha Trainer", variant: null },
  { manufacturer: "Pipistrel", model: "Panthera", variant: null },
  { manufacturer: "Pipistrel", model: "Velis Electro", variant: null },
  // Tecnam
  { manufacturer: "Tecnam", model: "P92", variant: "Echo" },
  { manufacturer: "Tecnam", model: "P92", variant: "Eaglet" },
  { manufacturer: "Tecnam", model: "P2002", variant: "Sierra" },
  { manufacturer: "Tecnam", model: "P2008", variant: "JC" },
  { manufacturer: "Tecnam", model: "P2006T", variant: null },
  { manufacturer: "Tecnam", model: "P2010", variant: null },
  { manufacturer: "Tecnam", model: "P-Mentor", variant: null },
  // Savage / Zlin
  { manufacturer: "Zlin Savage", model: "Savage Cub", variant: null },
  { manufacturer: "Zlin Savage", model: "Savage Cruiser", variant: null },
  { manufacturer: "Zlin Savage", model: "Savage Bobber", variant: null },
  { manufacturer: "Zlin Savage", model: "Savage Norden", variant: null },
  // AutoGyro
  { manufacturer: "AutoGyro", model: "Calidus", variant: null },
  { manufacturer: "AutoGyro", model: "Cavalon", variant: null },
  { manufacturer: "AutoGyro", model: "Cavalon", variant: "Pro" },
  { manufacturer: "AutoGyro", model: "MTOsport", variant: null },
  { manufacturer: "AutoGyro", model: "MTO", variant: "Classic" },
  // Aeropilot
  { manufacturer: "Aeropilot", model: "Legend 600", variant: null },
  { manufacturer: "Aeropilot", model: "Legend 540", variant: null },
  // Evektor
  { manufacturer: "Evektor", model: "EV-97", variant: "Eurostar" },
  { manufacturer: "Evektor", model: "EV-97", variant: "Harmony" },
  { manufacturer: "Evektor", model: "SportStar", variant: "RTC" },
  // Remos
  { manufacturer: "Remos", model: "GX", variant: null },
  { manufacturer: "Remos", model: "GXiS", variant: null },
  { manufacturer: "Remos", model: "G-3", variant: "600" },
  // Pioneer
  { manufacturer: "Pioneer", model: "300", variant: null },
  { manufacturer: "Pioneer", model: "300", variant: "Griffon" },
  { manufacturer: "Pioneer", model: "200", variant: null },
  // FK Lightplanes
  { manufacturer: "FK Lightplanes", model: "FK9", variant: "ELA" },
  { manufacturer: "FK Lightplanes", model: "FK9", variant: "Mark VI" },
  { manufacturer: "FK Lightplanes", model: "FK131", variant: null },
  { manufacturer: "FK Lightplanes", model: "FK14", variant: "Polaris" },
  // Roland Aircraft
  { manufacturer: "Roland", model: "Z602", variant: null },
  { manufacturer: "Roland", model: "Z601", variant: null },
  // ICP
  { manufacturer: "ICP", model: "Savannah", variant: "S" },
  { manufacturer: "ICP", model: "Savannah", variant: "XL" },
  { manufacturer: "ICP", model: "Ventura", variant: null },
  // Eurofox
  { manufacturer: "Aeropro", model: "Eurofox", variant: null },
  { manufacturer: "Aeropro", model: "Eurofox", variant: "3K" },
  // FlySynthesis
  { manufacturer: "FlySynthesis", model: "Storch", variant: null },
  { manufacturer: "FlySynthesis", model: "Texan", variant: null },
  // TL Ultralight
  { manufacturer: "TL Ultralight", model: "TL-3000 Sirius", variant: null },
  { manufacturer: "TL Ultralight", model: "TL-2000 Sting", variant: "S4" },
  { manufacturer: "TL Ultralight", model: "TL-96 Star", variant: null },
  // DynAero
  { manufacturer: "DynAero", model: "MCR 01", variant: "ULC" },
  { manufacturer: "DynAero", model: "MCR 4S", variant: null },
  // Heller
  { manufacturer: "Heller", model: "UL Sprint", variant: null },
  // Zenair
  { manufacturer: "Zenair", model: "CH701", variant: "STOL" },
  { manufacturer: "Zenair", model: "CH750", variant: null },
  { manufacturer: "Zenair", model: "CH650", variant: null },
  // Aeroprakt
  { manufacturer: "Aeroprakt", model: "A-22", variant: "Foxbat" },
  { manufacturer: "Aeroprakt", model: "A-22", variant: "LS" },
  { manufacturer: "Aeroprakt", model: "A-32", variant: "Vixxen" },
  // BRM Aero
  { manufacturer: "BRM Aero", model: "Bristell", variant: "NG5" },
  { manufacturer: "BRM Aero", model: "Bristell", variant: "B23" },
  // Vampire
  { manufacturer: "Vampire", model: "FM250", variant: null },
  // Fresh Breeze (Paramotor trikes)
  { manufacturer: "Fresh Breeze", model: "XCitor", variant: null },
  // Rans
  { manufacturer: "Rans", model: "S-6", variant: "Coyote II" },
  { manufacturer: "Rans", model: "S-7", variant: "Courier" },
  { manufacturer: "Rans", model: "S-19", variant: "Venterra" },
  { manufacturer: "Rans", model: "S-21", variant: "Outbound" },
  // Rotax Wing (Trike/Weightshift)
  { manufacturer: "Air Creation", model: "Tanarg", variant: null },
  { manufacturer: "Air Creation", model: "Clipper", variant: null },
  { manufacturer: "Air Creation", model: "iXess", variant: null },
  // Magni Gyro
  { manufacturer: "Magni", model: "M16", variant: null },
  { manufacturer: "Magni", model: "M22", variant: null },
  { manufacturer: "Magni", model: "M24", variant: "Orion" },
  // Celier Aviation
  { manufacturer: "Celier", model: "Xenon", variant: null },
  // Blackshape
  { manufacturer: "Blackshape", model: "Prime", variant: null },
  { manufacturer: "Blackshape", model: "Gabriel", variant: null },
  // Tomark
  { manufacturer: "Tomark", model: "Viper SD-4", variant: null },
  // Shark Aero
  { manufacturer: "Shark Aero", model: "Shark", variant: "UL" },
  // Atec
  { manufacturer: "Atec", model: "Faeta", variant: "321" },
  { manufacturer: "Atec", model: "Zephyr", variant: "2000" },
  // Eurostar / Ekolot
  { manufacturer: "Ekolot", model: "JK-05", variant: "Junior" },
  // Czech Sport Aircraft
  { manufacturer: "Czech Sport Aircraft", model: "PS-28", variant: "Cruiser" },
  { manufacturer: "Czech Sport Aircraft", model: "SportCruiser", variant: null },
  // Sling Aircraft
  { manufacturer: "Sling Aircraft", model: "Sling 2", variant: null },
  { manufacturer: "Sling Aircraft", model: "Sling 4", variant: null },
  { manufacturer: "Sling Aircraft", model: "Sling TSi", variant: null },
  // Van's Aircraft (Experimental)
  { manufacturer: "Vans", model: "RV-7", variant: null },
  { manufacturer: "Vans", model: "RV-8", variant: null },
  { manufacturer: "Vans", model: "RV-9", variant: null },
  { manufacturer: "Vans", model: "RV-10", variant: null },
  { manufacturer: "Vans", model: "RV-12", variant: null },
  { manufacturer: "Vans", model: "RV-14", variant: null },

  // ===== SINGLE ENGINE PISTON =====
  // Cessna
  { manufacturer: "Cessna", model: "150", variant: null },
  { manufacturer: "Cessna", model: "152", variant: null },
  { manufacturer: "Cessna", model: "172", variant: "Skyhawk" },
  { manufacturer: "Cessna", model: "172", variant: "SP" },
  { manufacturer: "Cessna", model: "177", variant: "Cardinal" },
  { manufacturer: "Cessna", model: "182", variant: "Skylane" },
  { manufacturer: "Cessna", model: "206", variant: "Stationair" },
  { manufacturer: "Cessna", model: "210", variant: "Centurion" },
  { manufacturer: "Cessna", model: "TTx", variant: null },
  // Piper
  { manufacturer: "Piper", model: "PA-28", variant: "Cherokee" },
  { manufacturer: "Piper", model: "PA-28", variant: "Warrior" },
  { manufacturer: "Piper", model: "PA-28", variant: "Archer" },
  { manufacturer: "Piper", model: "PA-28", variant: "Arrow" },
  { manufacturer: "Piper", model: "PA-32", variant: "Saratoga" },
  { manufacturer: "Piper", model: "PA-32", variant: "Lance" },
  { manufacturer: "Piper", model: "PA-18", variant: "Super Cub" },
  { manufacturer: "Piper", model: "PA-22", variant: "Tri-Pacer" },
  { manufacturer: "Piper", model: "PA-38", variant: "Tomahawk" },
  { manufacturer: "Piper", model: "PA-46", variant: "Malibu" },
  { manufacturer: "Piper", model: "PA-46", variant: "Matrix" },
  // Beechcraft
  { manufacturer: "Beechcraft", model: "Bonanza", variant: "A36" },
  { manufacturer: "Beechcraft", model: "Bonanza", variant: "G36" },
  { manufacturer: "Beechcraft", model: "Bonanza", variant: "V35" },
  { manufacturer: "Beechcraft", model: "Musketeer", variant: null },
  { manufacturer: "Beechcraft", model: "Sierra", variant: null },
  { manufacturer: "Beechcraft", model: "Sundowner", variant: null },
  // Cirrus
  { manufacturer: "Cirrus", model: "SR20", variant: null },
  { manufacturer: "Cirrus", model: "SR22", variant: null },
  { manufacturer: "Cirrus", model: "SR22T", variant: null },
  // Diamond
  { manufacturer: "Diamond", model: "DA20", variant: "Katana" },
  { manufacturer: "Diamond", model: "DA40", variant: "Diamond Star" },
  { manufacturer: "Diamond", model: "DA42", variant: "Twin Star" },
  { manufacturer: "Diamond", model: "DA50", variant: "RG" },
  { manufacturer: "Diamond", model: "DA62", variant: null },
  // Mooney
  { manufacturer: "Mooney", model: "M20", variant: "Ovation" },
  { manufacturer: "Mooney", model: "M20", variant: "Acclaim" },
  { manufacturer: "Mooney", model: "M20", variant: "Bravo" },
  // Robin
  { manufacturer: "Robin", model: "DR400", variant: null },
  { manufacturer: "Robin", model: "DR400", variant: "180R" },
  { manufacturer: "Robin", model: "HR200", variant: null },
  // Grumman
  { manufacturer: "Grumman", model: "AA-5", variant: "Tiger" },
  { manufacturer: "Grumman", model: "AA-1", variant: "Yankee" },
  // Socata / Daher
  { manufacturer: "Socata", model: "TB-10", variant: "Tobago" },
  { manufacturer: "Socata", model: "TB-20", variant: "Trinidad" },
  { manufacturer: "Socata", model: "TB-9", variant: "Tampico" },
  { manufacturer: "Socata", model: "Rallye", variant: null },
  // Extra
  { manufacturer: "Extra", model: "EA-300", variant: null },
  { manufacturer: "Extra", model: "EA-330", variant: null },
  // Maule
  { manufacturer: "Maule", model: "MX-7", variant: null },
  { manufacturer: "Maule", model: "M-7", variant: null },
  // Husky
  { manufacturer: "Aviat", model: "Husky", variant: "A-1C" },
  // American Champion
  { manufacturer: "American Champion", model: "Scout", variant: null },
  { manufacturer: "American Champion", model: "Decathlon", variant: null },
  // CubCrafters
  { manufacturer: "CubCrafters", model: "Carbon Cub", variant: "EX-3" },
  { manufacturer: "CubCrafters", model: "XCub", variant: null },
  { manufacturer: "CubCrafters", model: "NXCub", variant: null },

  // ===== MULTI ENGINE PISTON =====
  { manufacturer: "Piper", model: "PA-34", variant: "Seneca" },
  { manufacturer: "Piper", model: "PA-44", variant: "Seminole" },
  { manufacturer: "Piper", model: "PA-23", variant: "Aztec" },
  { manufacturer: "Beechcraft", model: "Baron", variant: "58" },
  { manufacturer: "Beechcraft", model: "Baron", variant: "G58" },
  { manufacturer: "Beechcraft", model: "Duchess", variant: null },
  { manufacturer: "Cessna", model: "310", variant: null },
  { manufacturer: "Cessna", model: "340", variant: null },
  { manufacturer: "Cessna", model: "402", variant: null },
  { manufacturer: "Cessna", model: "414", variant: null },

  // ===== TURBOPROP =====
  { manufacturer: "Daher", model: "TBM 960", variant: null },
  { manufacturer: "Daher", model: "TBM 940", variant: null },
  { manufacturer: "Daher", model: "TBM 930", variant: null },
  { manufacturer: "Daher", model: "TBM 900", variant: null },
  { manufacturer: "Daher", model: "TBM 850", variant: null },
  { manufacturer: "Pilatus", model: "PC-12", variant: "NGX" },
  { manufacturer: "Pilatus", model: "PC-12", variant: "NG" },
  { manufacturer: "Pilatus", model: "PC-6", variant: "Porter" },
  { manufacturer: "Beechcraft", model: "King Air", variant: "250" },
  { manufacturer: "Beechcraft", model: "King Air", variant: "350" },
  { manufacturer: "Beechcraft", model: "King Air", variant: "90" },
  { manufacturer: "Piper", model: "PA-46", variant: "Meridian" },
  { manufacturer: "Piper", model: "M600", variant: "SLS" },
  { manufacturer: "Cessna", model: "208", variant: "Caravan" },
  { manufacturer: "Cessna", model: "208B", variant: "Grand Caravan" },
  { manufacturer: "Epic", model: "E1000", variant: "GX" },

  // ===== VERY LIGHT JET / LIGHT JET =====
  { manufacturer: "Cirrus", model: "SF50", variant: "Vision Jet" },
  { manufacturer: "Eclipse", model: "550", variant: null },
  { manufacturer: "Cessna", model: "Citation Mustang", variant: null },
  { manufacturer: "Cessna", model: "Citation CJ3+", variant: null },
  { manufacturer: "Cessna", model: "Citation CJ4", variant: null },
  { manufacturer: "Cessna", model: "Citation M2+", variant: null },
  { manufacturer: "Embraer", model: "Phenom 100", variant: "EV" },
  { manufacturer: "Embraer", model: "Phenom 300", variant: "E" },
  { manufacturer: "HondaJet", model: "HA-420", variant: "Elite II" },

  // ===== MID-SIZE / SUPER MID-SIZE JET =====
  { manufacturer: "Cessna", model: "Citation XLS+", variant: null },
  { manufacturer: "Cessna", model: "Citation Latitude", variant: null },
  { manufacturer: "Cessna", model: "Citation Longitude", variant: null },
  { manufacturer: "Bombardier", model: "Challenger 350", variant: null },
  { manufacturer: "Bombardier", model: "Challenger 3500", variant: null },
  { manufacturer: "Embraer", model: "Praetor 500", variant: null },
  { manufacturer: "Embraer", model: "Praetor 600", variant: null },
  { manufacturer: "Gulfstream", model: "G280", variant: null },
  { manufacturer: "Dassault", model: "Falcon 2000", variant: "LXS" },

  // ===== HEAVY / ULTRA LONG RANGE JET =====
  { manufacturer: "Gulfstream", model: "G650", variant: "ER" },
  { manufacturer: "Gulfstream", model: "G700", variant: null },
  { manufacturer: "Gulfstream", model: "G550", variant: null },
  { manufacturer: "Bombardier", model: "Global 7500", variant: null },
  { manufacturer: "Bombardier", model: "Global 6500", variant: null },
  { manufacturer: "Dassault", model: "Falcon 8X", variant: null },
  { manufacturer: "Dassault", model: "Falcon 7X", variant: null },
  { manufacturer: "Dassault", model: "Falcon 6X", variant: null },

  // ===== HELICOPTER =====
  { manufacturer: "Robinson", model: "R22", variant: null },
  { manufacturer: "Robinson", model: "R44", variant: "Raven II" },
  { manufacturer: "Robinson", model: "R66", variant: null },
  { manufacturer: "Airbus Helicopters", model: "H125", variant: null },
  { manufacturer: "Airbus Helicopters", model: "H130", variant: null },
  { manufacturer: "Airbus Helicopters", model: "H135", variant: null },
  { manufacturer: "Airbus Helicopters", model: "H145", variant: null },
  { manufacturer: "Bell", model: "206", variant: "JetRanger" },
  { manufacturer: "Bell", model: "407", variant: "GXi" },
  { manufacturer: "Bell", model: "505", variant: "Jet Ranger X" },
  { manufacturer: "Leonardo", model: "AW109", variant: "Trekker" },
  { manufacturer: "Leonardo", model: "AW169", variant: null },
  { manufacturer: "MD Helicopters", model: "MD 500", variant: "E" },
  { manufacturer: "MD Helicopters", model: "MD 530F", variant: null },
  { manufacturer: "Guimbal", model: "Cabri G2", variant: null },
  { manufacturer: "Schweizer", model: "300", variant: "CBi" },

  // ===== EXPERIMENTAL / HOMEBUILT =====
  { manufacturer: "Lancair", model: "Evolution", variant: null },
  { manufacturer: "Lancair", model: "IV-P", variant: null },
  { manufacturer: "Glasair", model: "Sportsman", variant: null },
  { manufacturer: "Glasair", model: "GlaStar", variant: null },
  { manufacturer: "Murphy", model: "Moose", variant: null },
  { manufacturer: "Murphy", model: "Rebel", variant: null },
  { manufacturer: "Sonex", model: "Sonex", variant: null },
  { manufacturer: "Sonex", model: "Waiex", variant: null },
  // Pitts
  { manufacturer: "Pitts", model: "S-1", variant: "Special" },
  { manufacturer: "Pitts", model: "S-2", variant: "Special" },
  // Sbach / XtremeAir
  { manufacturer: "XtremeAir", model: "Sbach 300", variant: null },
  { manufacturer: "XtremeAir", model: "Sbach 342", variant: null },

  // ===== ADDITIONAL UL/LSA/MICROLIGHT =====
  // Jabiru
  { manufacturer: "Jabiru", model: "J170", variant: null },
  { manufacturer: "Jabiru", model: "J230", variant: null },
  { manufacturer: "Jabiru", model: "J430", variant: null },
  // Aerospool
  { manufacturer: "Aerospool", model: "WT-9", variant: "Dynamic LSA" },
  { manufacturer: "Aerospool", model: "WT-10", variant: "Advantic" },
  // Ikarus
  { manufacturer: "Comco Ikarus", model: "C42", variant: "CS" },
  // Corvus
  { manufacturer: "Corvus", model: "Phantom", variant: null },
  { manufacturer: "Corvus", model: "Racer 540", variant: null },
  // AeroJones
  { manufacturer: "Pelegrin", model: "Tarragon", variant: null },
  // Alpi Aviation
  { manufacturer: "Alpi Aviation", model: "Pioneer 200", variant: null },
  { manufacturer: "Alpi Aviation", model: "Pioneer 300", variant: "Hawk" },
  { manufacturer: "Alpi Aviation", model: "Pioneer 400", variant: null },
  // Eurostar
  { manufacturer: "Evektor", model: "Harmony", variant: "UL" },
  // SD Planes
  { manufacturer: "SD Planes", model: "SD-1", variant: "Minisport" },
  { manufacturer: "SD Planes", model: "SD-2", variant: "Sportster" },
  // Aero AT
  { manufacturer: "Aero AT", model: "AT-3", variant: null },
  // B&F Technik
  { manufacturer: "B&F Technik", model: "FK-12", variant: "Comet" },
  // Hummel
  { manufacturer: "Hummel", model: "UltraCruiser", variant: null },
  // Just Aircraft
  { manufacturer: "Just Aircraft", model: "SuperSTOL", variant: null },
  { manufacturer: "Just Aircraft", model: "Highlander", variant: null },
  // Kitfox
  { manufacturer: "Kitfox", model: "Kitfox", variant: "VII" },
  { manufacturer: "Kitfox", model: "Kitfox", variant: "S7 Super Sport" },
  // Skyranger
  { manufacturer: "Flylight", model: "Skyranger", variant: "Swift" },
  { manufacturer: "Flylight", model: "Skyranger", variant: "Nynja" },
  // P&M Aviation (Trikes)
  { manufacturer: "P&M Aviation", model: "Quik", variant: "GTR" },
  { manufacturer: "P&M Aviation", model: "PulsR", variant: null },
  // Cosmos (Trikes)
  { manufacturer: "Cosmos", model: "Chronos", variant: null },
  // AirBorne (Trikes)
  { manufacturer: "Airborne", model: "XT912", variant: "Tundra" },
  // Rotax-powered motorgliders
  { manufacturer: "Stemme", model: "S12", variant: null },
  { manufacturer: "Stemme", model: "S10-VT", variant: null },
  { manufacturer: "Schempp-Hirth", model: "Arcus", variant: "M" },
  { manufacturer: "DG Flugzeugbau", model: "DG-808S", variant: null },
  // Scheibe
  { manufacturer: "Scheibe", model: "SF-25", variant: "Falke" },
  { manufacturer: "Scheibe", model: "SF-28", variant: "Tandem Falke" },
  // Breezer Aircraft
  { manufacturer: "Breezer Aircraft", model: "Breezer", variant: "B600" },
  { manufacturer: "Breezer Aircraft", model: "Breezer", variant: "Sport" },
  // JMB Aircraft
  { manufacturer: "JMB Aircraft", model: "VL-3", variant: "Evolution" },
  // Pottier
  { manufacturer: "Pottier", model: "P-180S", variant: null },
  // AeroStar
  { manufacturer: "AeroStar", model: "Festival", variant: null },
  // PS-Flugzeugbau
  { manufacturer: "PS-Flugzeugbau", model: "Drachen-Trike", variant: null },
  // Storch
  { manufacturer: "Storch", model: "HS", variant: null },

  // ===== ADDITIONAL SINGLE ENGINE PISTON =====
  // Cessna additional
  { manufacturer: "Cessna", model: "170", variant: null },
  { manufacturer: "Cessna", model: "180", variant: "Skywagon" },
  { manufacturer: "Cessna", model: "185", variant: "Skywagon" },
  { manufacturer: "Cessna", model: "188", variant: "AGwagon" },
  { manufacturer: "Cessna", model: "195", variant: null },
  { manufacturer: "Cessna", model: "205", variant: null },
  { manufacturer: "Cessna", model: "207", variant: "Stationair 7" },
  { manufacturer: "Cessna", model: "337", variant: "Skymaster" },
  { manufacturer: "Cessna", model: "T206H", variant: "Turbo Stationair" },
  // Piper additional
  { manufacturer: "Piper", model: "J-3", variant: "Cub" },
  { manufacturer: "Piper", model: "PA-11", variant: "Cub Special" },
  { manufacturer: "Piper", model: "PA-12", variant: "Super Cruiser" },
  { manufacturer: "Piper", model: "PA-20", variant: "Pacer" },
  { manufacturer: "Piper", model: "PA-24", variant: "Comanche" },
  { manufacturer: "Piper", model: "PA-25", variant: "Pawnee" },
  { manufacturer: "Piper", model: "PA-28R", variant: "Arrow" },
  { manufacturer: "Piper", model: "PA-32R", variant: "Cherokee Six" },
  { manufacturer: "Piper", model: "PA-36", variant: "Brave" },
  { manufacturer: "Piper", model: "PA-46T", variant: "Mirage" },
  // Beechcraft additional
  { manufacturer: "Beechcraft", model: "Bonanza", variant: "F33A" },
  { manufacturer: "Beechcraft", model: "Debonair", variant: null },
  { manufacturer: "Beechcraft", model: "Skipper", variant: null },
  // Diamond additional
  { manufacturer: "Diamond", model: "DA20", variant: "Eclipse" },
  { manufacturer: "Diamond", model: "DA40", variant: "NG" },
  { manufacturer: "Diamond", model: "DA50", variant: "Magnum" },
  { manufacturer: "Diamond", model: "HK36", variant: "Super Dimona" },
  // Cirrus additional
  { manufacturer: "Cirrus", model: "SR20", variant: "G6" },
  { manufacturer: "Cirrus", model: "SR22", variant: "G6" },
  // Robin additional
  { manufacturer: "Robin", model: "DR400", variant: "120" },
  { manufacturer: "Robin", model: "DR400", variant: "140B" },
  { manufacturer: "Robin", model: "ATL", variant: null },
  { manufacturer: "Robin", model: "R2160", variant: null },
  // Socata / Daher additional
  { manufacturer: "Socata", model: "MS880", variant: "Rallye" },
  { manufacturer: "Socata", model: "MS893", variant: "Rallye Commodore" },
  { manufacturer: "Socata", model: "TB-21", variant: "Trinidad TC" },
  { manufacturer: "Socata", model: "Tampico", variant: null },
  { manufacturer: "Socata", model: "Tobago", variant: null },
  // Jodel
  { manufacturer: "Jodel", model: "DR1050", variant: null },
  { manufacturer: "Jodel", model: "D112", variant: null },
  { manufacturer: "Jodel", model: "D140", variant: "Mousquetaire" },
  // Grob
  { manufacturer: "Grob", model: "G115", variant: null },
  { manufacturer: "Grob", model: "G120TP", variant: null },
  // Zlin
  { manufacturer: "Zlin", model: "Z142", variant: null },
  { manufacturer: "Zlin", model: "Z242L", variant: null },
  { manufacturer: "Zlin", model: "Z526", variant: "Trener Master" },
  { manufacturer: "Zlin", model: "Z50", variant: null },
  // Fuji / Subaru
  { manufacturer: "Fuji", model: "FA-200", variant: "Aero Subaru" },
  // Commander
  { manufacturer: "Commander", model: "112", variant: null },
  { manufacturer: "Commander", model: "114", variant: null },
  // Lake
  { manufacturer: "Lake", model: "LA-4", variant: "Buccaneer" },
  { manufacturer: "Lake", model: "Renegade", variant: null },
  // Bellanca
  { manufacturer: "Bellanca", model: "Viking", variant: null },
  { manufacturer: "Bellanca", model: "Citabria", variant: null },
  { manufacturer: "Bellanca", model: "Decathlon", variant: null },
  // Stinson
  { manufacturer: "Stinson", model: "108", variant: "Voyager" },
  // Luscombe
  { manufacturer: "Luscombe", model: "8", variant: "Silvaire" },
  // Aeronca
  { manufacturer: "Aeronca", model: "7AC", variant: "Champion" },
  { manufacturer: "Aeronca", model: "11AC", variant: "Chief" },
  // Taylorcraft
  { manufacturer: "Taylorcraft", model: "BC-12D", variant: null },
  // Globe/Temco
  { manufacturer: "Globe", model: "GC-1", variant: "Swift" },
  // Ercoupe
  { manufacturer: "Ercoupe", model: "415", variant: null },

  // ===== ADDITIONAL MULTI ENGINE PISTON =====
  { manufacturer: "Piper", model: "PA-30", variant: "Twin Comanche" },
  { manufacturer: "Piper", model: "PA-31", variant: "Navajo" },
  { manufacturer: "Piper", model: "PA-31T", variant: "Cheyenne" },
  { manufacturer: "Cessna", model: "303", variant: "Crusader" },
  { manufacturer: "Cessna", model: "320", variant: "Skyknight" },
  { manufacturer: "Cessna", model: "335", variant: null },
  { manufacturer: "Cessna", model: "401", variant: null },
  { manufacturer: "Cessna", model: "421", variant: "Golden Eagle" },
  { manufacturer: "Beechcraft", model: "Travel Air", variant: null },
  { manufacturer: "Beechcraft", model: "Baron", variant: "55" },
  { manufacturer: "Beechcraft", model: "Queen Air", variant: null },
  { manufacturer: "Partenavia", model: "P68", variant: null },
  { manufacturer: "Vulcanair", model: "P68", variant: "Observer" },
  { manufacturer: "Tecnam", model: "P2006T", variant: "MkII" },
  { manufacturer: "Diamond", model: "DA42", variant: "VI" },
  { manufacturer: "Grumman", model: "Widgeon", variant: null },
  { manufacturer: "De Havilland", model: "DHC-6", variant: "Twin Otter" },

  // ===== ADDITIONAL TURBOPROP =====
  { manufacturer: "Pilatus", model: "PC-21", variant: null },
  { manufacturer: "Beechcraft", model: "King Air", variant: "C90" },
  { manufacturer: "Beechcraft", model: "King Air", variant: "200" },
  { manufacturer: "Beechcraft", model: "King Air", variant: "360" },
  { manufacturer: "Beechcraft", model: "1900D", variant: null },
  { manufacturer: "Cessna", model: "425", variant: "Corsair" },
  { manufacturer: "Cessna", model: "441", variant: "Conquest II" },
  { manufacturer: "Piper", model: "PA-42", variant: "Cheyenne III" },
  { manufacturer: "Piper", model: "M500", variant: null },
  { manufacturer: "Piaggio", model: "P180", variant: "Avanti EVO" },
  { manufacturer: "Socata", model: "TBM 700", variant: null },
  { manufacturer: "Pacific Aerospace", model: "P-750", variant: "XSTOL" },
  { manufacturer: "Quest", model: "Kodiak", variant: "100" },
  { manufacturer: "Daher", model: "Kodiak", variant: "900" },
  { manufacturer: "STOL", model: "CH-801", variant: null },
  { manufacturer: "Dornier", model: "Do 228", variant: null },
  { manufacturer: "Short Brothers", model: "SC.7 Skyvan", variant: null },
  { manufacturer: "ATR", model: "42-600", variant: null },
  { manufacturer: "ATR", model: "72-600", variant: null },

  // ===== ADDITIONAL JETS (VLJ / LIGHT / MID / HEAVY) =====
  // Light Jet (formerly Very Light Jet)
  { manufacturer: "Eclipse", model: "500", variant: null },
  { manufacturer: "Stratos", model: "714", variant: null },
  // Light Jet
  { manufacturer: "Cessna", model: "Citation CJ1+", variant: null },
  { manufacturer: "Cessna", model: "Citation CJ2+", variant: null },
  { manufacturer: "Embraer", model: "Phenom 100", variant: null },
  { manufacturer: "Embraer", model: "Phenom 300", variant: null },
  { manufacturer: "Learjet", model: "45", variant: "XR" },
  { manufacturer: "Learjet", model: "75", variant: "Liberty" },
  { manufacturer: "Pilatus", model: "PC-24", variant: null },
  { manufacturer: "Nextant", model: "400XTi", variant: null },
  // Mid-Size Jet
  { manufacturer: "Cessna", model: "Citation Sovereign+", variant: null },
  { manufacturer: "Cessna", model: "Citation Excel", variant: null },
  { manufacturer: "Hawker", model: "400XP", variant: null },
  { manufacturer: "Hawker", model: "800XP", variant: null },
  { manufacturer: "Hawker", model: "900XP", variant: null },
  { manufacturer: "Bombardier", model: "Learjet 60", variant: "XR" },
  // Mid-Size Jet (formerly Super Mid-Size Jet)
  { manufacturer: "Cessna", model: "Citation X+", variant: null },
  { manufacturer: "Bombardier", model: "Challenger 300", variant: null },
  { manufacturer: "Bombardier", model: "Challenger 604", variant: null },
  { manufacturer: "Bombardier", model: "Challenger 650", variant: null },
  { manufacturer: "Dassault", model: "Falcon 900", variant: "LX" },
  { manufacturer: "Dassault", model: "Falcon 2000", variant: "EX" },
  // Heavy Jet (formerly Heavy / Ultra Long Range)
  { manufacturer: "Gulfstream", model: "G450", variant: null },
  { manufacturer: "Gulfstream", model: "G500", variant: null },
  { manufacturer: "Gulfstream", model: "G600", variant: null },
  { manufacturer: "Gulfstream", model: "GIV-SP", variant: null },
  { manufacturer: "Gulfstream", model: "GV", variant: null },
  { manufacturer: "Bombardier", model: "Global 5500", variant: null },
  { manufacturer: "Bombardier", model: "Global Express", variant: "XRS" },
  { manufacturer: "Dassault", model: "Falcon 50", variant: "EX" },
  { manufacturer: "Boeing", model: "BBJ", variant: "737-800" },
  { manufacturer: "Airbus", model: "ACJ319neo", variant: null },
  { manufacturer: "Embraer", model: "Legacy 450", variant: null },
  { manufacturer: "Embraer", model: "Legacy 500", variant: null },
  { manufacturer: "Embraer", model: "Legacy 600", variant: null },
  { manufacturer: "Embraer", model: "Lineage 1000E", variant: null },

  // ===== ADDITIONAL HELICOPTERS =====
  { manufacturer: "Robinson", model: "R44", variant: "Cadet" },
  { manufacturer: "Robinson", model: "R44", variant: "Clipper" },
  { manufacturer: "Airbus Helicopters", model: "H120", variant: null },
  { manufacturer: "Airbus Helicopters", model: "H155", variant: null },
  { manufacturer: "Airbus Helicopters", model: "H160", variant: null },
  { manufacturer: "Airbus Helicopters", model: "H175", variant: null },
  { manufacturer: "Airbus Helicopters", model: "H215", variant: null },
  { manufacturer: "Airbus Helicopters", model: "H225", variant: null },
  { manufacturer: "Bell", model: "212", variant: null },
  { manufacturer: "Bell", model: "412", variant: "EPI" },
  { manufacturer: "Bell", model: "429", variant: null },
  { manufacturer: "Bell", model: "525", variant: "Relentless" },
  { manufacturer: "Sikorsky", model: "S-76", variant: "D" },
  { manufacturer: "Sikorsky", model: "S-92", variant: null },
  { manufacturer: "Leonardo", model: "AW109", variant: "GrandNew" },
  { manufacturer: "Leonardo", model: "AW139", variant: null },
  { manufacturer: "Leonardo", model: "AW189", variant: null },
  { manufacturer: "Enstrom", model: "280FX", variant: null },
  { manufacturer: "Enstrom", model: "480B", variant: null },
  { manufacturer: "Kopter", model: "SH09", variant: null },

  // ===== ADDITIONAL GYROCOPTERS =====
  { manufacturer: "AutoGyro", model: "Calidus", variant: "912" },
  { manufacturer: "AutoGyro", model: "Calidus", variant: "915" },
  { manufacturer: "Magni", model: "M14", variant: null },
  { manufacturer: "Magni", model: "M16", variant: "Tandem Trainer" },
  { manufacturer: "ELA Aviacion", model: "ELA 07", variant: null },
  { manufacturer: "ELA Aviacion", model: "ELA 10", variant: "Eclipse" },
  { manufacturer: "Trendak", model: "Zen1", variant: null },
  { manufacturer: "RotorSchmiede", model: "VA115", variant: null },
  { manufacturer: "ArrowCopter", model: "AC20", variant: null },

  // ===== ADDITIONAL EXPERIMENTALS / AEROBATIC =====
  { manufacturer: "Vans", model: "RV-3", variant: null },
  { manufacturer: "Vans", model: "RV-4", variant: null },
  { manufacturer: "Vans", model: "RV-6", variant: null },
  { manufacturer: "Vans", model: "RV-6A", variant: null },
  { manufacturer: "Vans", model: "RV-7A", variant: null },
  { manufacturer: "Vans", model: "RV-8A", variant: null },
  { manufacturer: "Vans", model: "RV-9A", variant: null },
  { manufacturer: "Vans", model: "RV-12iS", variant: null },
  { manufacturer: "Vans", model: "RV-14A", variant: null },
  { manufacturer: "Lancair", model: "320", variant: null },
  { manufacturer: "Lancair", model: "360", variant: null },
  { manufacturer: "Glasair", model: "III", variant: null },
  { manufacturer: "Glasair", model: "Aviation Merlin", variant: null },
  { manufacturer: "Murphy", model: "Elite", variant: null },
  { manufacturer: "Murphy", model: "Renegade", variant: null },
  { manufacturer: "Sonex", model: "Onex", variant: null },
  { manufacturer: "Sonex", model: "SubSonex", variant: null },
  { manufacturer: "Sling Aircraft", model: "Sling High Wing", variant: null },
  // Aerobatic
  { manufacturer: "Extra", model: "EA-200", variant: null },
  { manufacturer: "Extra", model: "EA-300L", variant: null },
  { manufacturer: "Extra", model: "EA-300LT", variant: null },
  { manufacturer: "Sukhoi", model: "Su-26", variant: null },
  { manufacturer: "Sukhoi", model: "Su-29", variant: null },
  { manufacturer: "Sukhoi", model: "Su-31", variant: null },
  { manufacturer: "MXR", model: "MX-2", variant: null },
  { manufacturer: "Cap Aviation", model: "CAP 10", variant: null },
  { manufacturer: "Cap Aviation", model: "CAP 232", variant: null },
  { manufacturer: "Mudry", model: "CAP 10B", variant: null },
  // Yak
  { manufacturer: "Yakovlev", model: "Yak-52", variant: null },
  { manufacturer: "Yakovlev", model: "Yak-18T", variant: null },
  { manufacturer: "Yakovlev", model: "Yak-55", variant: null },
  // Nanchang
  { manufacturer: "Nanchang", model: "CJ-6", variant: null },
  // North American (Warbirds)
  { manufacturer: "North American", model: "T-6", variant: "Texan" },
  { manufacturer: "De Havilland", model: "DHC-1", variant: "Chipmunk" },
  { manufacturer: "Scottish Aviation", model: "Bulldog", variant: null },

  // ===== ADDITIONAL POPULAR AIRCRAFT (EXTENDED SEED) =====

  // Cessna high-wing trainers & utility
  { manufacturer: "Cessna", model: "120", variant: null },
  { manufacturer: "Cessna", model: "140", variant: null },
  { manufacturer: "Cessna", model: "150", variant: "Aerobat" },
  { manufacturer: "Cessna", model: "162", variant: "Skycatcher" },
  { manufacturer: "Cessna", model: "172", variant: "Skyhawk II" },
  { manufacturer: "Cessna", model: "172", variant: "RG Cutlass" },
  { manufacturer: "Cessna", model: "175", variant: "Skylark" },
  { manufacturer: "Cessna", model: "177", variant: "Cardinal RG" },
  { manufacturer: "Cessna", model: "182", variant: "Turbo Skylane" },
  { manufacturer: "Cessna", model: "185", variant: null },
  { manufacturer: "Cessna", model: "190", variant: null },
  { manufacturer: "Cessna", model: "206H", variant: "Stationair" },
  { manufacturer: "Cessna", model: "208", variant: "Caravan EX" },

  // Piper classics & modern
  { manufacturer: "Piper", model: "PA-15", variant: "Vagabond" },
  { manufacturer: "Piper", model: "PA-16", variant: "Clipper" },
  { manufacturer: "Piper", model: "PA-17", variant: "Vagabond" },
  { manufacturer: "Piper", model: "PA-28", variant: "Cadet" },
  { manufacturer: "Piper", model: "PA-28", variant: "Dakota" },
  { manufacturer: "Piper", model: "PA-28", variant: "Turbo Arrow IV" },
  { manufacturer: "Piper", model: "PA-32", variant: "Cherokee Six" },
  { manufacturer: "Piper", model: "PA-32R", variant: "Saratoga II HP" },
  { manufacturer: "Piper", model: "PA-46", variant: "350P" },
  { manufacturer: "Piper", model: "M350", variant: null },
  { manufacturer: "Piper", model: "M500", variant: null },

  // Beechcraft additional
  { manufacturer: "Beechcraft", model: "Bonanza", variant: "S35" },
  { manufacturer: "Beechcraft", model: "Bonanza", variant: "V35B" },
  { manufacturer: "Beechcraft", model: "Bonanza", variant: "A36TC" },
  { manufacturer: "Beechcraft", model: "Bonanza", variant: "B36TC" },
  { manufacturer: "Beechcraft", model: "Baron", variant: "B55" },
  { manufacturer: "Beechcraft", model: "Baron", variant: "E55" },
  { manufacturer: "Beechcraft", model: "T-34", variant: "Mentor" },
  { manufacturer: "Beechcraft", model: "Starship", variant: null },

  // Mooney additional
  { manufacturer: "Mooney", model: "M20", variant: "J (201)" },
  { manufacturer: "Mooney", model: "M20", variant: "K (231)" },
  { manufacturer: "Mooney", model: "M20", variant: "R (Ovation)" },
  { manufacturer: "Mooney", model: "M20", variant: "S (Eagle)" },
  { manufacturer: "Mooney", model: "M20", variant: "TN (Acclaim)" },
  { manufacturer: "Mooney", model: "M20", variant: "U (Ultra)" },

  // Grumman/American General
  { manufacturer: "Grumman", model: "AA-5", variant: "Traveler" },
  { manufacturer: "Grumman", model: "AA-5A", variant: "Cheetah" },
  { manufacturer: "Grumman", model: "AA-5B", variant: "Tiger" },
  { manufacturer: "Grumman", model: "AG-5B", variant: "Tiger" },

  // Maule STOL
  { manufacturer: "Maule", model: "M-4", variant: "Rocket" },
  { manufacturer: "Maule", model: "M-5", variant: "Lunar Rocket" },
  { manufacturer: "Maule", model: "M-6", variant: "Super Rocket" },
  { manufacturer: "Maule", model: "M-7-260C", variant: null },
  { manufacturer: "Maule", model: "MT-7-260", variant: null },

  // Waco / classic biplanes
  { manufacturer: "Waco", model: "YMF-5", variant: null },
  { manufacturer: "Great Lakes", model: "2T-1A-2", variant: null },
  { manufacturer: "Stearman", model: "PT-17", variant: null },

  // European GA
  { manufacturer: "Aquila", model: "AT01", variant: "A210" },
  { manufacturer: "Aquila", model: "AT01", variant: "A211" },
  { manufacturer: "SIAI-Marchetti", model: "SF260", variant: null },
  { manufacturer: "Pilatus", model: "P-3", variant: null },
  { manufacturer: "FFA", model: "AS202", variant: "Bravo" },

  // Warbirds / vintage
  { manufacturer: "North American", model: "P-51", variant: "Mustang" },
  { manufacturer: "North American", model: "AT-6", variant: "Texan" },
  { manufacturer: "De Havilland", model: "DH.82", variant: "Tiger Moth" },
  { manufacturer: "De Havilland", model: "DHC-2", variant: "Beaver" },
  { manufacturer: "De Havilland", model: "DHC-3", variant: "Otter" },
  { manufacturer: "Pilatus", model: "PC-7", variant: null },
  { manufacturer: "Pilatus", model: "PC-9", variant: null },
  { manufacturer: "Beechcraft", model: "T-34A", variant: "Mentor" },
  { manufacturer: "Noorduyn", model: "AT-16", variant: "Harvard" },

  // Amphibians / floatplanes
  { manufacturer: "Icon", model: "A5", variant: null },
  { manufacturer: "Progressive Aerodyne", model: "SeaRey", variant: "Elite" },
  { manufacturer: "Searey", model: "LSX", variant: null },
  { manufacturer: "Republic", model: "RC-3", variant: "Seabee" },
  { manufacturer: "Dornier", model: "Seastar", variant: null },

  // Modern LSA additions
  { manufacturer: "Tecnam", model: "P92", variant: "Tail Dragger" },
  { manufacturer: "Tecnam", model: "P2002", variant: "JF" },
  { manufacturer: "Tecnam", model: "P2012", variant: "Traveller" },
  { manufacturer: "Pipistrel", model: "Virus", variant: "SW 915" },
  { manufacturer: "Pipistrel", model: "Sinus", variant: "Flex" },
  { manufacturer: "Flight Design", model: "MC", variant: null },
  { manufacturer: "Bristell", model: "B23", variant: "Fiti" },
  { manufacturer: "Bristell", model: "TDO", variant: null },

  // Turboprop additions
  { manufacturer: "Daher", model: "TBM 700", variant: "N" },
  { manufacturer: "Daher", model: "TBM 910", variant: null },
  { manufacturer: "Daher", model: "Kodiak", variant: "100 Series III" },
  { manufacturer: "Beechcraft", model: "King Air", variant: "B200" },
  { manufacturer: "Beechcraft", model: "King Air", variant: "F90" },
  { manufacturer: "Beechcraft", model: "Super King Air", variant: "350i" },
  { manufacturer: "Cessna", model: "425", variant: "Conquest I" },
  { manufacturer: "Cessna", model: "441", variant: "Conquest" },
  { manufacturer: "Mitsubishi", model: "MU-2", variant: null },
  { manufacturer: "Dornier", model: "228", variant: "NG" },
  { manufacturer: "De Havilland Canada", model: "DHC-6", variant: "Twin Otter 400" },

  // Jet additions
  { manufacturer: "Cessna", model: "Citation Bravo", variant: null },
  { manufacturer: "Cessna", model: "Citation Encore+", variant: null },
  { manufacturer: "Cessna", model: "Citation V", variant: "Ultra" },
  { manufacturer: "Cessna", model: "Citation VII", variant: null },
  { manufacturer: "Bombardier", model: "Learjet 31A", variant: null },
  { manufacturer: "Bombardier", model: "Learjet 35A", variant: null },
  { manufacturer: "Bombardier", model: "Learjet 40", variant: "XR" },
  { manufacturer: "Bombardier", model: "Learjet 55", variant: null },
  { manufacturer: "Bombardier", model: "Global 5000", variant: null },
  { manufacturer: "Bombardier", model: "Global 6000", variant: null },
  { manufacturer: "Bombardier", model: "Global 8000", variant: null },
  { manufacturer: "Gulfstream", model: "G100", variant: null },
  { manufacturer: "Gulfstream", model: "G150", variant: null },
  { manufacturer: "Gulfstream", model: "G200", variant: null },
  { manufacturer: "Gulfstream", model: "G350", variant: null },
  { manufacturer: "Gulfstream", model: "G400", variant: null },
  { manufacturer: "Gulfstream", model: "G800", variant: null },
  { manufacturer: "Dassault", model: "Falcon 10", variant: null },
  { manufacturer: "Dassault", model: "Falcon 20", variant: null },
  { manufacturer: "Dassault", model: "Falcon 50", variant: null },
  { manufacturer: "Dassault", model: "Falcon 900", variant: "EX" },
  { manufacturer: "Dassault", model: "Falcon 900", variant: "DX" },
  { manufacturer: "Embraer", model: "Legacy 650", variant: null },
  { manufacturer: "Embraer", model: "Legacy 650E", variant: null },

  // Helicopter additions
  { manufacturer: "Robinson", model: "R22", variant: "Beta II" },
  { manufacturer: "Robinson", model: "R44", variant: "Raven I" },
  { manufacturer: "Robinson", model: "R66", variant: "Turbine Marine" },
  { manufacturer: "Bell", model: "47", variant: null },
  { manufacturer: "Bell", model: "206L", variant: "LongRanger" },
  { manufacturer: "Bell", model: "222", variant: null },
  { manufacturer: "Bell", model: "230", variant: null },
  { manufacturer: "Bell", model: "412", variant: "EP" },
  { manufacturer: "Bell", model: "430", variant: null },
  { manufacturer: "Airbus Helicopters", model: "EC120", variant: "Colibri" },
  { manufacturer: "Airbus Helicopters", model: "EC130", variant: "T2" },
  { manufacturer: "Airbus Helicopters", model: "EC135", variant: "P3" },
  { manufacturer: "Airbus Helicopters", model: "AS350", variant: "B3e" },
  { manufacturer: "Airbus Helicopters", model: "AS355", variant: "N" },
  { manufacturer: "Sikorsky", model: "S-76", variant: "C++" },
  { manufacturer: "Sikorsky", model: "S-76", variant: "B" },
  { manufacturer: "Sikorsky", model: "S-70", variant: null },
  { manufacturer: "MD Helicopters", model: "MD 902", variant: "Explorer" },
  { manufacturer: "MD Helicopters", model: "MD 600N", variant: null },

  // Electric / hybrid (emerging)
  { manufacturer: "Bye Aerospace", model: "eFlyer 2", variant: null },
  { manufacturer: "Pipistrel", model: "Velis Electro", variant: "SW 128" },
  { manufacturer: "Eviation", model: "Alice", variant: null },
  { manufacturer: "Heart Aerospace", model: "ES-30", variant: null },

  // ===== UL TRIKES / WEIGHT-SHIFT / PARAMOTORS =====
  // Toni Roth (German trike builder)
  { manufacturer: "Toni Roth", model: "Carbon Trike", variant: null },
  // Royal (French trikes)
  { manufacturer: "Royal", model: "912 ULS", variant: null },
  { manufacturer: "Royal", model: "912 UL", variant: null },
  // Take Off (German trikes)
  { manufacturer: "Take Off", model: "Merlin", variant: "1000" },
  { manufacturer: "Take Off", model: "Merlin", variant: "1200" },
  // Eagle (trikes)
  { manufacturer: "Eagle", model: "Eagle V", variant: "Trike" },
  // Bautek (German trikes)
  { manufacturer: "Bautek", model: "Pico", variant: null },
  { manufacturer: "Bautek", model: "Skycruiser", variant: null },
  // Diamant (German trikes)
  { manufacturer: "Diamant", model: "LP Trike", variant: null },
  // La Mouette (French hang gliders / trikes)
  { manufacturer: "La Mouette", model: "Samson", variant: null },
  { manufacturer: "La Mouette", model: "Top", variant: null },
  // Drachen-Trike builders
  { manufacturer: "Drachenflieger", model: "Drachen-Trike", variant: null },
  // SUNFLIGHTCRAFT (paramotors/trikes)
  { manufacturer: "Sunflightcraft", model: "Airchopper", variant: null },
  // Aeros (Ukrainian hang gliders / trikes)
  { manufacturer: "Aeros", model: "Discus", variant: null },
  { manufacturer: "Aeros", model: "ANT", variant: null },
  { manufacturer: "Aeros", model: "Combat", variant: null },
  // Truster (Australian trikes)
  { manufacturer: "Truster", model: "Thor", variant: null },
  // APOLLO (trikes/ULs)
  { manufacturer: "Apollo", model: "Delta Jet", variant: null },
  { manufacturer: "Apollo", model: "Fox", variant: null },
  // Air Création (French trikes)
  { manufacturer: "Air Création", model: "Tanarg", variant: null },
  { manufacturer: "Air Création", model: "Skypper", variant: null },
  { manufacturer: "Air Création", model: "iXess", variant: null },
  // Parazoom / Paramotor brands
  { manufacturer: "Parazoom", model: "Triostar", variant: null },
  // XCitor (paramotors)
  { manufacturer: "XCitor", model: "XC", variant: null },

  // ===== ADDITIONAL GYROCOPTERS =====
  // Tercel (gyrocopter)
  { manufacturer: "Tercel", model: "Exclusive", variant: null },
  // RotorSchmiede (German gyrocopter)
  { manufacturer: "RotorSchmiede", model: "VA115", variant: null },
  // Magni (Italian gyrocopter)
  { manufacturer: "Magni", model: "M16", variant: "Tandem Trainer" },
  { manufacturer: "Magni", model: "M22", variant: "Voyager" },
  { manufacturer: "Magni", model: "M24", variant: "Orion" },
  // ArrowCopter (Austrian gyrocopter)
  { manufacturer: "ArrowCopter", model: "AC20", variant: null },
  // Trendak (Polish gyrocopter/UL)
  { manufacturer: "Trendak", model: "Dragon", variant: null },

  // ===== ADDITIONAL UL / LSA MANUFACTURERS =====
  // Fascination (German UL)
  { manufacturer: "Fascination", model: "D4", variant: null },
  // Eurostar (German UL)
  { manufacturer: "Eurostar", model: "EV97", variant: null },
  { manufacturer: "Eurostar", model: "SL", variant: null },
  // Dallach (Austrian UL)
  { manufacturer: "Dallach", model: "Sunrise", variant: null },
  { manufacturer: "Dallach", model: "D4", variant: "Fascination" },
  // ICP (Italian UL)
  { manufacturer: "ICP", model: "Savannah", variant: null },
  { manufacturer: "ICP", model: "Savannah", variant: "S" },
  { manufacturer: "ICP", model: "Bingo", variant: null },
  // Roland (German UL)
  { manufacturer: "Roland", model: "Z-602", variant: null },
  // SD Planes (Czech UL)
  { manufacturer: "SD Planes", model: "SD-1", variant: "Minisport" },
  { manufacturer: "SD Planes", model: "SD-2", variant: null },
  // Aeropro (Slovak UL)
  { manufacturer: "Aeropro", model: "EuroFox", variant: null },
  { manufacturer: "Aeropro", model: "EuroFox", variant: "2K" },
  // Heller (German UL)
  { manufacturer: "Heller", model: "UH-1", variant: null },
  // Just Aircraft (US kitbuilt)
  { manufacturer: "Just Aircraft", model: "SuperSTOL", variant: null },
  { manufacturer: "Just Aircraft", model: "Highlander", variant: null },
  // Kitfox (US kitbuilt)
  { manufacturer: "Kitfox", model: "Series 7", variant: "Super Sport" },
  { manufacturer: "Kitfox", model: "Speedster", variant: null },
  // ELA (Spanish UL)
  { manufacturer: "ELA", model: "Eclipse", variant: null },
  { manufacturer: "ELA", model: "07", variant: null },
  // FK Lightplanes (German UL)
  { manufacturer: "FK Lightplanes", model: "FK9", variant: "Mark VI" },
  { manufacturer: "FK Lightplanes", model: "FK14", variant: "Polaris" },
  // Blackshape (Italian UL)
  { manufacturer: "Blackshape", model: "Prime", variant: null },
  { manufacturer: "Blackshape", model: "Gabriel", variant: null },
  // Pioneer (Italian UL)
  { manufacturer: "Pioneer", model: "300", variant: null },
  { manufacturer: "Pioneer", model: "400", variant: null },
  // Shark Aero (Slovak UL)
  { manufacturer: "Shark Aero", model: "Shark", variant: "UL" },
  // MTO (German gyrocopter)
  { manufacturer: "MTO", model: "Sport", variant: null },
  // Rotorsport (German gyrocopter)
  { manufacturer: "Rotorsport", model: "MT-03", variant: null },
  { manufacturer: "Rotorsport", model: "Calidus", variant: null },
  // T.E.A.M. (French UL)
  { manufacturer: "T.E.A.M.", model: "Mini-Max", variant: null },
  // Swan (UL trike)
  { manufacturer: "Swan", model: "UL", variant: null },
  // Serk (German trike)
  { manufacturer: "Serk", model: "Trike", variant: null },
  // SFS (German UL)
  { manufacturer: "SFS", model: "Tandem", variant: null },
  // STOL (UL category)
  { manufacturer: "STOL", model: "CH701", variant: null },
];

const SYSTEM_PROMPT = `You are an aviation engineer providing accurate aircraft performance specifications.

Given an aircraft manufacturer, model, and optional variant, return the standard performance specs as JSON.

Use metric units. Only include data you are confident about. For values you're unsure of, use null.

Return ONLY valid JSON with this exact structure (no markdown):
{
  "cruise_speed": "185",
  "max_speed": "220",
  "max_range": "1200",
  "service_ceiling": "15000",
  "climb_rate": "5.5",
  "takeoff_distance": "200",
  "landing_distance": "180",
  "fuel_consumption": "18",
  "empty_weight": "310",
  "max_takeoff_weight": "600",
  "max_payload": "290",
  "fuel_capacity": "100",
  "engine_type": "Rotax 912 ULS",
  "engine_power": "100",
  "fuel_type": "MOGAS",
  "seats": "2"
}`;

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!supabaseUrl || !supabaseKey || !anthropicKey) {
    console.error("Missing env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY");
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseKey);
  const anthropic = new Anthropic();

  console.log(`Seeding ${MODELS.length} aircraft reference specs...\n`);

  let success = 0;
  let failed = 0;

  for (const model of MODELS) {
    const label = `${model.manufacturer} ${model.model}${model.variant ? ` ${model.variant}` : ""}`;

    try {
      // Check if already exists
      const { data: existing } = await supabase
        .from("aircraft_reference_specs")
        .select("id")
        .eq("manufacturer", model.manufacturer)
        .eq("model", model.model)
        .eq("variant", model.variant ?? "")
        .maybeSingle();

      if (existing) {
        console.log(`  SKIP ${label} (already exists)`);
        continue;
      }

      // Ask Claude for specs
      const response = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [{
          role: "user",
          content: `Aircraft: ${label}\nPlease provide the standard performance specifications.`,
        }],
      });

      const text = response.content[0].type === "text" ? response.content[0].text : "";
      const jsonStr = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      const specs = JSON.parse(jsonStr);

      // Insert into DB
      const { error } = await supabase.from("aircraft_reference_specs").insert({
        manufacturer: model.manufacturer,
        model: model.model,
        variant: model.variant ?? "",
        cruise_speed: specs.cruise_speed,
        max_speed: specs.max_speed,
        max_range: specs.max_range,
        service_ceiling: specs.service_ceiling,
        climb_rate: specs.climb_rate,
        takeoff_distance: specs.takeoff_distance,
        landing_distance: specs.landing_distance,
        fuel_consumption: specs.fuel_consumption,
        empty_weight: specs.empty_weight,
        max_takeoff_weight: specs.max_takeoff_weight,
        max_payload: specs.max_payload,
        fuel_capacity: specs.fuel_capacity,
        engine_type: specs.engine_type,
        engine_power: specs.engine_power,
        engine_power_unit: "PS",
        fuel_type: specs.fuel_type,
        seats: specs.seats ?? "2",
        source: "claude-haiku",
        confidence: "high",
      });

      if (error) {
        console.log(`  FAIL ${label}: ${error.message}`);
        failed++;
      } else {
        console.log(`  OK   ${label}`);
        success++;
      }

      // Polite delay
      await new Promise((r) => setTimeout(r, 200));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  FAIL ${label}: ${msg}`);
      failed++;
    }
  }

  console.log(`\nDone: ${success} seeded, ${failed} failed, ${MODELS.length - success - failed} skipped`);

  // === SECOND PASS: Fill in skeleton rows (from UGC listings) with null specs ===
  console.log("\nChecking for skeleton rows with missing specs...\n");

  const { data: skeletons } = await supabase
    .from("aircraft_reference_specs")
    .select("id, manufacturer, model, variant")
    .is("cruise_speed", null)
    .is("engine_type", null);

  if (skeletons && skeletons.length > 0) {
    console.log(`Found ${skeletons.length} skeleton rows to fill.\n`);
    let filled = 0;
    let fillFailed = 0;

    for (const row of skeletons) {
      const label = `${row.manufacturer} ${row.model}${row.variant ? ` ${row.variant}` : ""}`;

      try {
        const response = await anthropic.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1024,
          temperature: 0,
          system: SYSTEM_PROMPT,
          messages: [{
            role: "user",
            content: `Aircraft: ${label}\nPlease provide the standard performance specifications.`,
          }],
        });

        const text = response.content[0].type === "text" ? response.content[0].text : "";
        const jsonStr = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
        const specs = JSON.parse(jsonStr);

        const { error } = await supabase
          .from("aircraft_reference_specs")
          .update({
            cruise_speed: specs.cruise_speed,
            max_speed: specs.max_speed,
            max_range: specs.max_range,
            service_ceiling: specs.service_ceiling,
            climb_rate: specs.climb_rate,
            takeoff_distance: specs.takeoff_distance,
            landing_distance: specs.landing_distance,
            fuel_consumption: specs.fuel_consumption,
            empty_weight: specs.empty_weight,
            max_takeoff_weight: specs.max_takeoff_weight,
            max_payload: specs.max_payload,
            fuel_capacity: specs.fuel_capacity,
            engine_type: specs.engine_type,
            engine_power: specs.engine_power,
            engine_power_unit: "PS",
            fuel_type: specs.fuel_type,
            seats: specs.seats ?? "2",
            source: "claude-haiku",
            confidence: "high",
          })
          .eq("id", row.id);

        if (error) {
          console.log(`  FAIL ${label}: ${error.message}`);
          fillFailed++;
        } else {
          console.log(`  FILL ${label}`);
          filled++;
        }

        await new Promise((r) => setTimeout(r, 200));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  FAIL ${label}: ${msg}`);
        fillFailed++;
      }
    }

    console.log(`\nSkeleton fill: ${filled} filled, ${fillFailed} failed`);
  } else {
    console.log("No skeleton rows found.");
  }
}

main().catch(console.error);
