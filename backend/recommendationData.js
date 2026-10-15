// recommendationData.js - Comprehensive Rules for Crop Management Plan
// NOTE: ALL soil_type fields have been standardized to match the 5 options in crop-selection.html:
// "Loamy", "Clay", "Sandy", "Fertile", "Deep"
// Prices (USD) and dosages are for illustrative purposes.

export const cropPlanRules = [
    // === CROP 1: TOMATO (Fruits) - Original: Well-drained loamy soil -> Loamy ===
    {
        crop_name: "Tomato", soil_type: "Loamy", cultivation_method: "Conventional",
        growth_stage: "Basal Application", fertilizer_type: "DAP (Di-Ammonium Phosphate)",
        fertilizer_quantity: "50 kg/hectare", unit_of_measure: "kg", estimated_unit_price_usd: 0.45,
    },
    {
        crop_name: "Tomato", soil_type: "Loamy", cultivation_method: "Conventional",
        pest_name: "Early Blight", management_type: "Chemical Control",
        input_recommendation: "Mancozeb 75% WP", application_rate: "200 grams/hectare (Prevention)",
        unit_of_measure: "gram", estimated_unit_price_usd: 0.02,
    },
    {
        crop_name: "Tomato", soil_type: "Loamy", cultivation_method: "Organic",
        growth_stage: "Basal Application", fertilizer_type: "Cow Dung Manure",
        fertilizer_quantity: "20 tons/hectare", unit_of_measure: "ton", estimated_unit_price_usd: 5.00,
    },
    {
        crop_name: "Tomato", soil_type: "Loamy", cultivation_method: "Organic",
        pest_name: "Aphids", management_type: "Preventative Spray",
        input_recommendation: "Neem Oil (Azadirachtin 0.3%)", application_rate: "10 liters/hectare",
        unit_of_measure: "liter", estimated_unit_price_usd: 3.50,
    },
    
    // === CROP 2: WHEAT (Grains) - Original: Well-drained clay loam -> Clay ===
    {
        crop_name: "Wheat", soil_type: "Clay", cultivation_method: "Conventional",
        growth_stage: "Sowing", fertilizer_type: "NPK 10:26:26 Complex",
        fertilizer_quantity: "125 kg/hectare", unit_of_measure: "kg", estimated_unit_price_usd: 0.60,
    },
    {
        crop_name: "Wheat", soil_type: "Clay", cultivation_method: "Conventional",
        pest_name: "Weed Control (Broadleaf)", management_type: "Chemical Control",
        input_recommendation: "2,4-D Ethyl Ester", application_rate: "1 liter/hectare",
        unit_of_measure: "liter", estimated_unit_price_usd: 8.00,
    },
    {
        crop_name: "Wheat", soil_type: "Clay", cultivation_method: "Organic",
        growth_stage: "Tillering Stage", fertilizer_type: "Farm Yard Manure (FYM)",
        fertilizer_quantity: "15 tons/hectare", unit_of_measure: "ton", estimated_unit_price_usd: 4.00,
    },
    
    // === CROP 3: RICE (Grains) - Original: Clayey or loamy soil that retains water -> Clay ===
    {
        crop_name: "Rice", soil_type: "Clay", cultivation_method: "Conventional",
        growth_stage: "Puddling/Transplanting", fertilizer_type: "Urea",
        fertilizer_quantity: "150 kg/hectare (Split Dose)", unit_of_measure: "kg", estimated_unit_price_usd: 0.30,
    },
    {
        crop_name: "Rice", soil_type: "Clay", cultivation_method: "Conventional",
        pest_name: "Stem Borer", management_type: "Chemical Control",
        input_recommendation: "Cartap Hydrochloride", application_rate: "500 grams/hectare",
        unit_of_measure: "gram", estimated_unit_price_usd: 0.03,
    },
    {
        crop_name: "Rice", soil_type: "Clay", cultivation_method: "Organic",
        growth_stage: "Pre-Transplanting", fertilizer_type: "Green Manure (Sunhemp)",
        fertilizer_quantity: "N/A", unit_of_measure: "unit", estimated_unit_price_usd: 0.00,
    },
    
    // === CROP 4: POTATO (Vegetables) - Original: Well-drained sandy loam -> Sandy ===
    {
        crop_name: "Potato", soil_type: "Sandy", cultivation_method: "Conventional",
        growth_stage: "Planting", fertilizer_type: "DAP + SOP (Sulphate of Potash)",
        fertilizer_quantity: "180 kg/hectare", unit_of_measure: "kg", estimated_unit_price_usd: 0.70,
    },
    {
        crop_name: "Potato", soil_type: "Sandy", cultivation_method: "Organic",
        growth_stage: "Tuber Formation", fertilizer_type: "Vermicompost",
        fertilizer_quantity: "2 tons/hectare", unit_of_measure: "ton", estimated_unit_price_usd: 200.00,
    },

    // === CROP 5: MANGO (Fruits) - Original: Deep, well-drained soil -> Deep ===
    {
        crop_name: "Mango", soil_type: "Deep", cultivation_method: "Conventional",
        growth_stage: "Pre-Flowering", fertilizer_type: "NPK 18:10:10",
        fertilizer_quantity: "2 kg/tree", unit_of_measure: "kg", estimated_unit_price_usd: 1.20,
    },
    {
        crop_name: "Mango", soil_type: "Deep", cultivation_method: "Organic",
        growth_stage: "Post-Harvest", fertilizer_type: "Bone Meal + Compost",
        fertilizer_quantity: "15 kg/tree", unit_of_measure: "kg", estimated_unit_price_usd: 0.80,
    },
    
    // === CROP 6: CHICKPEA (Pulses) - Original: Sandy loam to clay loam -> Loamy ===
    {
        crop_name: "Chickpea", soil_type: "Loamy", cultivation_method: "Conventional",
        growth_stage: "Sowing", fertilizer_type: "SSP (Single Super Phosphate)",
        fertilizer_quantity: "100 kg/hectare", unit_of_measure: "kg", estimated_unit_price_usd: 0.25,
    },
    {
        crop_name: "Chickpea", soil_type: "Loamy", cultivation_method: "Organic",
        growth_stage: "Sowing", fertilizer_type: "Rhizobium Inoculant",
        fertilizer_quantity: "500 grams/hectare", unit_of_measure: "gram", estimated_unit_price_usd: 0.04,
    },

    // === CROP 7: ONION (Vegetables) - Original: Well-drained sandy loam -> Sandy ===
    {
        crop_name: "Onion", soil_type: "Sandy", cultivation_method: "Conventional",
        growth_stage: "Bulb Development", fertilizer_type: "Potash and Sulphur",
        fertilizer_quantity: "80 kg/hectare", unit_of_measure: "kg", estimated_unit_price_usd: 0.90,
    },
    {
        crop_name: "Onion", soil_type: "Sandy", cultivation_method: "Organic",
        pest_name: "Thrips", management_type: "Biological Control",
        input_recommendation: "Beauveria bassiana", application_rate: "2 liters/hectare",
        unit_of_measure: "liter", estimated_unit_price_usd: 15.00,
    },

    // === CROP 8: CARROT (Vegetables) - Original: Sandy, well-drained soil -> Sandy ===
    {
        crop_name: "Carrot", soil_type: "Sandy", cultivation_method: "Conventional",
        growth_stage: "Thinning", fertilizer_type: "Boron Supplement",
        fertilizer_quantity: "1 kg/hectare", unit_of_measure: "kg", estimated_unit_price_usd: 5.00,
    },
    
    // === CROP 9: CABBAGE (Vegetables) - Original: Well-drained, fertile soil -> Fertile ===
    {
        crop_name: "Cabbage", soil_type: "Fertile", cultivation_method: "Conventional",
        growth_stage: "Head Formation", fertilizer_type: "Nitrogen (Calcium Nitrate)",
        fertilizer_quantity: "100 kg/hectare", unit_of_measure: "kg", estimated_unit_price_usd: 0.80,
    },

    // === CROP 10: CAULIFLOWER (Vegetables) - Original: Well-drained, fertile soil -> Fertile ===
    {
        crop_name: "Cauliflower", soil_type: "Fertile", cultivation_method: "Conventional",
        pest_name: "Cabbage Worms", management_type: "Chemical Control",
        input_recommendation: "Cypermethrin", application_rate: "300 ml/hectare",
        unit_of_measure: "ml", estimated_unit_price_usd: 0.02,
    },

    // === CROP 11: SPINACH (Vegetables) - Original: Well-drained, fertile soil -> Fertile ===
    {
        crop_name: "Spinach", soil_type: "Fertile", cultivation_method: "Organic",
        growth_stage: "Post-Harvest Cut", fertilizer_type: "Fish Emulsion",
        fertilizer_quantity: "5 liters/hectare", unit_of_measure: "liter", estimated_unit_price_usd: 4.50,
    },

    // === CROP 12: BRINJAL (Vegetables) - Original: Well-drained, fertile soil -> Fertile ===
    {
        crop_name: "Brinjal (Eggplant)", soil_type: "Fertile", cultivation_method: "Conventional",
        pest_name: "Fruit and Shoot Borer", management_type: "Chemical Control",
        input_recommendation: "Spinetoram", application_rate: "250 ml/hectare",
        unit_of_measure: "ml", estimated_unit_price_usd: 0.04,
    },

    // === CROP 13: OKRA (Vegetables) - Original: Well-drained, fertile soil -> Fertile ===
    {
        crop_name: "Okra (Lady's Finger)", soil_type: "Fertile", cultivation_method: "Organic",
        pest_name: "Jassids", management_type: "Preventative Spray",
        input_recommendation: "Garlic Extract Spray", application_rate: "N/A",
        unit_of_measure: "unit", estimated_unit_price_usd: 0.00,
    },

    // === CROP 14: CAPSICUM (Vegetables) - Original: Well-drained, fertile soil -> Fertile ===
    {
        crop_name: "Capsicum (Bell Pepper)", soil_type: "Fertile", cultivation_method: "Conventional",
        growth_stage: "Fruit Set", fertilizer_type: "Potassium Nitrate",
        fertilizer_quantity: "60 kg/hectare", unit_of_measure: "kg", estimated_unit_price_usd: 1.50,
    },
    
    // === CROP 15: MAIZE (Grains) - Original: Well-drained, fertile soil -> Fertile ===
    {
        crop_name: "Maize (Corn)", soil_type: "Fertile", cultivation_method: "Conventional",
        growth_stage: "Knee High Stage", fertilizer_type: "Urea",
        fertilizer_quantity: "120 kg/hectare", unit_of_measure: "kg", estimated_unit_price_usd: 0.30,
    },

    // === CROP 16: BARLEY (Grains) - Original: Well-drained, fertile soil -> Fertile ===
    {
        crop_name: "Barley", soil_type: "Fertile", cultivation_method: "Conventional",
        pest_name: "Aphids", management_type: "Chemical Control",
        input_recommendation: "Imidacloprid", application_rate: "150 ml/hectare",
        unit_of_measure: "ml", estimated_unit_price_usd: 0.03,
    },

    // === CROP 17: OATS (Grains) - Original: Well-drained, fertile soil -> Fertile ===
    {
        crop_name: "Oats", soil_type: "Fertile", cultivation_method: "Organic",
        growth_stage: "Tillering", fertilizer_type: "Liquid Seaweed Extract",
        fertilizer_quantity: "10 liters/hectare", unit_of_measure: "liter", estimated_unit_price_usd: 5.00,
    },

    // === CROP 18: BROCCOLI (Vegetables) - Original: Well-drained, fertile soil -> Fertile ===
    {
        crop_name: "Broccoli", soil_type: "Fertile", cultivation_method: "Conventional",
        growth_stage: "Curd Development", fertilizer_type: "Molybdenum Supplement",
        fertilizer_quantity: "500 grams/hectare", unit_of_measure: "gram", estimated_unit_price_usd: 0.08,
    },

    // === CROP 19: CUCUMBER (Vegetables) - Original: Well-drained, fertile soil -> Fertile ===
    {
        crop_name: "Cucumber", soil_type: "Fertile", cultivation_method: "Organic",
        pest_name: "Powdery Mildew", management_type: "Preventative Spray",
        input_recommendation: "Milk Spray (1:9 ratio)", application_rate: "N/A",
        unit_of_measure: "unit", estimated_unit_price_usd: 0.00,
    },

    // === CROP 20: BANANA (Fruits) - Original: Well-drained, fertile soil -> Fertile ===
    {
        crop_name: "Banana", soil_type: "Fertile", cultivation_method: "Conventional",
        growth_stage: "Flowering", fertilizer_type: "Potash (SOP)",
        fertilizer_quantity: "250 grams/plant", unit_of_measure: "gram", estimated_unit_price_usd: 0.005,
    },

    // === CROP 21: APPLE (Fruits) - Original: Well-drained loamy soil -> Loamy ===
    {
        crop_name: "Apple", soil_type: "Loamy", cultivation_method: "Conventional",
        pest_name: "Codling Moth", management_type: "Chemical Control",
        input_recommendation: "Carbaryl", application_rate: "200 grams/tree",
        unit_of_measure: "gram", estimated_unit_price_usd: 0.04,
    },

    // === CROP 22: ORANGE (Fruits) - Original: Well-drained sandy loam -> Sandy ===
    {
        crop_name: "Orange", soil_type: "Sandy", cultivation_method: "Organic",
        growth_stage: "Fruit Development", fertilizer_type: "Micronutrient Spray",
        fertilizer_quantity: "1 liter/tree", unit_of_measure: "liter", estimated_unit_price_usd: 5.00,
    },

    // === CROP 23: SORGHUM (Grains) - Original: Well-drained soil -> Fertile ===
    {
        crop_name: "Sorghum (Jowar)", soil_type: "Fertile", cultivation_method: "Conventional",
        growth_stage: "Flowering", fertilizer_type: "Phosphorus (DAP)",
        fertilizer_quantity: "40 kg/hectare", unit_of_measure: "kg", estimated_unit_price_usd: 0.45,
    },

    // === CROP 24: PEARL MILLET (Grains) - Original: Well-drained sandy soil -> Sandy ===
    {
        crop_name: "Pearl Millet (Bajra)", soil_type: "Sandy", cultivation_method: "Organic",
        growth_stage: "Sowing", fertilizer_type: "Composted Manure",
        fertilizer_quantity: "5 tons/hectare", unit_of_measure: "ton", estimated_unit_price_usd: 10.00,
    },

    // === CROP 25: LENTIL (Pulses) - Original: Well-drained loamy soil -> Loamy ===
    {
        crop_name: "Lentil (Masoor)", soil_type: "Loamy", cultivation_method: "Conventional",
        pest_name: "Pod Borer", management_type: "Chemical Control",
        input_recommendation: "Indoxacarb", application_rate: "100 ml/hectare",
        unit_of_measure: "ml", estimated_unit_price_usd: 0.05,
    },

    // === CROP 26: GREEN GRAM (Pulses) - Original: Well-drained sandy loam -> Sandy ===
    {
        crop_name: "Green Gram (Moong)", soil_type: "Sandy", cultivation_method: "Organic",
        growth_stage: "Pre-Flowering", fertilizer_type: "Foliar Spray (Neem Based)",
        fertilizer_quantity: "5 liters/hectare", unit_of_measure: "liter", estimated_unit_price_usd: 3.50,
    },
];