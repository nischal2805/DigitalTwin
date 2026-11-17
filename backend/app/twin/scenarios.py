"""Demo scenarios S1-S6."""
SCENARIOS = {
    "S1": {"title": "Roughing-stand bearing wear", "asset": "R1", "kind": "fault", "rate": 1 / 150,
           "blurb": "Slow spalling on the R1 work-roll bearing. Vibration and bearing temperature creep up."},
    "S2": {"title": "Cooling pump cavitation", "asset": "CB", "kind": "fault", "rate": 1 / 140,
           "blurb": "Main laminar-cooling pump starts cavitating; flow and pressure sag, strip runs hot."},
    "S3": {"title": "Vibration sensor glitch", "asset": "R1", "kind": "glitch", "tag": "R1.Vibration", "amp": 9.0,
           "blurb": "Loose accelerometer cable on R1. Erratic vibration, no real damage — AI should doubt itself."},
    "S4": {"title": "Finishing gearbox lube loss", "asset": "R2", "kind": "fault", "rate": 1 / 110,
           "blurb": "Oil film breaks down in the R2 gearbox; oil heats fast with rising mesh vibration."},
    "S5": {"title": "Furnace burner fouling (cascade)", "asset": "F1", "kind": "fault", "rate": 1 / 170,
           "blurb": "Burners foul; colder slabs cascade into higher roll force on R1."},
    "S6": {"title": "Model outage", "asset": None, "kind": "outage", "ticks": 30,
           "blurb": "The ML service goes down for 30 min. Watch the provenance badge fall back and recover."},
}
