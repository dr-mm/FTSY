import json
import os
import pandas as pd
import nflreadpy as nfl

print("🏈 Fetching latest NFL weekly stats via nflreadpy...")

try:
    seasons_to_load = [2025]
    dfs = []
    
    for season in seasons_to_load:
        try:
            s_df = nfl.load_player_stats(seasons=[season]).to_pandas()
            dfs.append(s_df)
            print(f"  ✓ Loaded {season} stats")
        except Exception:
            print(f"  ⚠️ Season {season} not available yet, skipping...")

    if dfs:
        df = pd.concat(dfs, ignore_index=True)
    else:
        df = nfl.load_player_stats().to_pandas()

    # 1. Clean String Fields
    string_cols = ['player_id', 'player_name', 'player_display_name', 'recent_team', 'opponent_team', 'season_type']
    for col in string_cols:
        if col in df.columns:
            df[col] = df[col].astype(str).str.strip()

    # 2. Strictly Filter Regular Season (REG) and Weeks 1-18
    if 'season_type' in df.columns:
        df = df[df['season_type'].str.upper() == 'REG']
    
    if 'week' in df.columns:
        df['week'] = pd.to_numeric(df['week'], errors='coerce').fillna(0).astype(int)
        df = df[(df['week'] >= 1) & (df['week'] <= 18)]

    if 'season' in df.columns:
        df['season'] = pd.to_numeric(df['season'], errors='coerce').fillna(0).astype(int)

    # 3. Ensure Numeric Stat Types
    stat_cols = ['passing_yards', 'passing_tds', 'rushing_yards', 'rushing_tds', 
                 'receiving_yards', 'receiving_tds', 'receptions', 'targets', 'fantasy_points_ppr']
    for col in stat_cols:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors='coerce').fillna(0.0)

    # 4. Sort by PPR points DESCENDING so actual played games come first
    if 'fantasy_points_ppr' in df.columns:
        df = df.sort_values(by=['season', 'player_id', 'week', 'fantasy_points_ppr'], ascending=[True, True, True, False])

    # 5. Drop Duplicate Weekly Entries
    if 'player_id' in df.columns:
        df = df.drop_duplicates(subset=['player_id', 'season', 'week'], keep='first')
    
    if 'player_display_name' in df.columns:
        df = df.drop_duplicates(subset=['player_display_name', 'season', 'week'], keep='first')

    # 6. Final Sort by Season and Week
    df = df.sort_values(by=['season', 'week'], ascending=[True, True])

    # Select essential columns
    cols = [
        'player_id', 'player_name', 'player_display_name', 'position', 'recent_team',
        'season', 'week', 'opponent_team', 'passing_yards', 'passing_tds',
        'rushing_yards', 'rushing_tds', 'receiving_yards', 'receiving_tds',
        'receptions', 'targets', 'fantasy_points_ppr'
    ]
    available_cols = [c for c in cols if c in df.columns]
    df_filtered = df[available_cols]

    # Output directly to weekly_stats.json
    output_file = "weekly_stats.json"
    df_filtered.to_json(output_file, orient="records", indent=2)
    print(f"✅ Stats successfully saved to {output_file} (Clean Regular Season Logs)!")

except Exception as e:
    print(f"❌ Error exporting stats: {e}")