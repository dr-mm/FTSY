import os
import sys
import subprocess
import pandas as pd
import streamlit as st

# ==========================================
# 1. ONE-BUTTON MASTER LAUNCHER
# ==========================================
if __name__ == "__main__" and not st.runtime.exists():
    print("🚀 Running Master NFL Script... Launching Interface!")
    subprocess.run([sys.executable, "-m", "streamlit", "run", __file__])
    sys.exit()

# ==========================================
# 2. CONFIG & LOCAL FILE SETTINGS
# ==========================================
st.set_page_config(page_title="NFL Player Stats Viewer", page_icon="🏈", layout="wide")

LOCAL_FILE = "weekly_stats.parquet" 

@st.cache_data
def load_weekly_data():
    """Loads data directly from the local file, or builds it using nflreadpy."""
    if os.path.exists(LOCAL_FILE):
        return pd.read_parquet(LOCAL_FILE)
    else:
        import nflreadpy as nfl
        # Fetch stats for recent seasons and save locally
        df = nfl.load_player_stats(seasons=[2023, 2024, 2025, 2026]).to_pandas()
        df.to_parquet(LOCAL_FILE)
        return df

# Notify status outside the cached data function
if os.path.exists(LOCAL_FILE):
    st.toast("✅ Loaded stats from Weekly Local File!")
else:
    st.toast("📥 Local file not found. Fetching fresh weekly data via nflreadpy...")

# Load dataset
df = load_weekly_data()

# ==========================================
# 3. POP-UP MODAL FUNCTION
# ==========================================
@st.dialog("📊 Player Stats Overview", width="large")
def show_player_stats_popup(player_name: str, player_df: pd.DataFrame):
    """Generates the pop-up modal when a player is clicked."""
    st.title(f"👤 {player_name}")
    
    col1, col2, col3, col4 = st.columns(4)
    
    pass_yds = int(player_df['passing_yards'].sum()) if 'passing_yards' in player_df else 0
    rush_yds = int(player_df['rushing_yards'].sum()) if 'rushing_yards' in player_df else 0
    rec_yds  = int(player_df['receiving_yards'].sum()) if 'receiving_yards' in player_df else 0
    
    td_cols = [c for c in ['passing_tds', 'rushing_tds', 'receiving_tds'] if c in player_df.columns]
    total_tds = int(player_df[td_cols].sum().sum()) if td_cols else 0

    col1.metric("Passing Yards", pass_yds)
    col2.metric("Rushing Yards", rush_yds)
    col3.metric("Receiving Yards", rec_yds)
    col4.metric("Total Touchdowns", total_tds)

    st.markdown("---")
    st.subheader("📅 Weekly Breakdown")

    display_cols = [
        col for col in ['season', 'week', 'recent_team', 'opponent_team', 
                        'passing_yards', 'rushing_yards', 'receiving_yards', 'fantasy_points_ppr'] 
        if col in player_df.columns
    ]
    
    st.dataframe(player_df[display_cols].sort_values(by=['season', 'week'], ascending=False), use_container_width=True)

# ==========================================
# 4. MAIN USER INTERFACE
# ==========================================
st.title("🏈 NFL Weekly Player Stats")
st.write("Click any player button below to open their detailed stats pop-up.")

search_term = st.text_input("🔍 Search Player:", "")

player_col = 'player_display_name' if 'player_display_name' in df.columns else 'player_name'

all_players = sorted(df[player_col].dropna().unique().tolist())

if search_term:
    all_players = [p for p in all_players if search_term.lower() in p.lower()]

st.caption(f"Showing {min(30, len(all_players))} of {len(all_players)} matching players:")

cols = st.columns(3)
for i, player in enumerate(all_players[:30]):
    col = cols[i % 3]
    if col.button(f"👤 {player}", key=f"btn_{player}_{i}", use_container_width=True):
        player_data = df[df[player_col] == player]
        show_player_stats_popup(player, player_data)