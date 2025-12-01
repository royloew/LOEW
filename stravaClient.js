// stravaClient.js
import fetch from "node-fetch";

const STRAVA_API_BASE = "https://www.strava.com/api/v3";

export class StravaClient {
  constructor(getAccessTokenForUser) {
    // פונקציה שאתה כבר כנראה מחזיק איפשהו:
    // (userId) => accessToken
    this.getAccessTokenForUser = getAccessTokenForUser;
  }

  async _get(userId, path, params = {}) {
    const token = await this.getAccessTokenForUser(userId);
    const url = new URL(STRAVA_API_BASE + path);
    Object.entries(params).forEach(([k, v]) =>
      url.searchParams.set(k, v)
    );

    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Strava GET ${path} failed: ${res.status} ${text}`);
    }
    return res.json();
  }

  async getActivity(userId, activityId) {
    return this._get(userId, `/activities/${activityId}`, {
      include_all_efforts: "false",
    });
  }

  async getActivities(userId, { after, perPage = 30, page = 1 } = {}) {
    const params = { per_page: perPage, page };
    if (after) params.after = after; // unix timestamp
    return this._get(userId, "/athlete/activities", params);
  }

  async getStreams(userId, activityId, keys = ["time", "watts", "heartrate", "distance"]) {
    const path = `/activities/${activityId}/streams`;
    const params = {
      keys: keys.join(","),
      key_by_type: "true",
    };
    return this._get(userId, path, params);
  }
}

