require("dotenv").config({ path: "./.env" });

const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const fetch = require("node-fetch");
const SpotifyWebApi = require("spotify-web-api-node");
const fs = require("fs");
const { google } = require("googleapis");

const app = express();
app.use(bodyParser.json());
app.use(cors());

// 환경 변수에서 프로젝트별 API 키 및 클라이언트 정보 가져오기
const PROJECT_KEYS_AND_CLIENTS = JSON.parse(process.env.PROJECT_KEYS_AND_CLIENTS);
let currentProjectIndex = 0;

// 현재 프로젝트의 API 키 가져오기
const getCurrentYouTubeApiKey = () => PROJECT_KEYS_AND_CLIENTS[currentProjectIndex].apiKey;

// 현재 프로젝트의 OAuth2 클라이언트 생성
const createOAuth2Client = () => {
  const project = PROJECT_KEYS_AND_CLIENTS[currentProjectIndex];
  return new google.auth.OAuth2(project.clientId, project.clientSecret, project.redirectUri);
};

const oauth2Client = new google.auth.OAuth2(
  process.env.CLIENT_ID,
  process.env.CLIENT_SECRET,
  process.env.REDIRECT_URI
);

// 프로젝트 순환 로직
const rotateProject = () => {
  // 프로젝트 인덱스 교체
  currentProjectIndex = (currentProjectIndex + 1) % PROJECT_KEYS_AND_CLIENTS.length;
  oauth2Client = createOAuth2Client(); // 새로운 프로젝트의 OAuth 클라이언트 생성
  initializeRefreshToken(); // 새 프로젝트의 Refresh Token 로드
  console.log(`Project rotated to Index: ${currentProjectIndex}, New API Key: ${getCurrentYouTubeApiKey()}`);

  // 현재 프로젝트의 Refresh Token 파일 로드
  const refreshTokenPath = `refresh_token_project_${currentProjectIndex}.json`;

  if (fs.existsSync(refreshTokenPath)) {
    const refreshToken = JSON.parse(fs.readFileSync(refreshTokenPath, "utf8"));
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    console.log("새 프로젝트의 Refresh Token 로드 완료");
  } else {
    console.log(`Refresh Token 파일이 없습니다. 인증이 필요합니다. /auth 경로로 인증을 진행하세요.`);
  }
};

// Spotify API 설정 및 Access Token 관리
const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
});
let spotifyAccessToken = null;
let tokenExpiryTime = null;

// Spotify Access Token 갱신 함수
const refreshSpotifyAccessToken = async () => {
  try {
    const data = await spotifyApi.clientCredentialsGrant();
    spotifyAccessToken = data.body["access_token"];
    tokenExpiryTime = Date.now() + data.body["expires_in"] * 1000; // 만료 시간 설정
    spotifyApi.setAccessToken(spotifyAccessToken);
    console.log("Spotify Access Token 갱신 완료:", spotifyAccessToken);
  } catch (error) {
    console.error("Spotify Access Token 갱신 중 오류:", error.message);
    throw new Error("Spotify Access Token 갱신 실패");
  }
};

// Access Token 유효성 확인 함수
const ensureSpotifyAccessToken = async () => {
  if (!spotifyAccessToken || Date.now() >= tokenExpiryTime) {
    console.log("Spotify Access Token 만료. 갱신 중...");
    await refreshSpotifyAccessToken();
  }
};

// Spotify 플레이리스트 가져오기
app.get("/spotify/playlist", async (req, res) => {
  const playlistId = req.query.id;

  if (!playlistId) {
    return res.status(400).json({ error: "플레이리스트 ID를 제공해주세요." });
  }

  try {
    await ensureSpotifyAccessToken(); // Spotify Access Token 갱신 확인
    const data = await spotifyApi.getPlaylist(playlistId);
    res.json({
      name: data.body.name,
      description: data.body.description,
      tracks: data.body.tracks.items.map((item) => ({
        name: item.track.name,
        artist: item.track.artists.map((artist) => artist.name).join(", "),
        album: item.track.album.name,
      })),
    });
  } catch (error) {
    console.error("Spotify API 호출 중 오류 발생:", error.message);
    res.status(500).json({ error: "플레이리스트를 가져오는 중 오류가 발생했습니다." });
  }
});

// YouTube 변환 로직
const convertToYouTube = async (track) => {
  try {
    console.log("Track for YouTube Search (Full Object):", track);

    if (!track || !track.name || !track.artist) {
      throw new Error("Track 데이터가 올바르지 않습니다.");
    }

    // 제목에서 "(with ~)" 및 "(feat. ~)" 제거
    const cleanedName = track.name
      .replace(/\(with [^\)]+\)/gi, "")
      .replace(/\(feat\. [^\)]+\)/gi, "")
      .trim();

    const searchQuery = `"${cleanedName}" "${track.artist}"`;
    const youtubeSearchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=relevance&key=${process.env.API_KEY}&q=${encodeURIComponent(
      searchQuery
    )}`;
    console.log("YouTube Search URL:", youtubeSearchUrl);

    const response = await fetch(youtubeSearchUrl);
    const data = await response.json();

    if (data.error && data.error.errors[0].reason === "quotaExceeded") {
      console.log("YouTube API Quota Exceeded. Rotating Project...");
      rotateProject(); // 다른 프로젝트로 전환
      return await convertToYouTube(track); // 재시도
    }

    if (data.items && data.items.length > 0) {
      // 가로형 비디오만 유지
      const validVideos = data.items.filter((item) => {
        const { width, height } = item.snippet.thumbnails.default;
        return width / height > 1; // 가로형 비디오만 유지
      });
    
      if (validVideos.length === 0) {
        throw new Error("가로형 비디오를 찾을 수 없습니다.");
      }
    
      let filteredVideos = validVideos;
    
      // 곡 제목에 "a colors show"가 없는 경우
      if (!track.name.toLowerCase().includes("a colors show")) {
        filteredVideos = validVideos.filter((item) => {
          const videoTitle = item.snippet.title.toUpperCase(); // 제목 대문자 변환
          return !videoTitle.includes("A COLORS SHOW");
        });
    
        console.log(
          `Filtered out videos with "A COLORS SHOW". Remaining videos: ${filteredVideos.length}`
        );
    
        if (filteredVideos.length === 0) {
          throw new Error(
            '"A COLORS SHOW"를 제외한 가로형 비디오를 찾을 수 없습니다.'
          );
        }
      } else {
        console.log(
          '곡 제목에 "a colors show"가 포함되어 있으므로 filtering을 생략합니다.'
        );
      }
    
      // Auto-Generated Video를 찾는 로직
      const searchTargetVideos =
        filteredVideos.length > 0 ? filteredVideos : validVideos;
    
      const autoGeneratedVideo = searchTargetVideos.find((item) => {
        const videoDescription = item.snippet.description.toLowerCase();
        const videoTitle = item.snippet.title.toLowerCase();
        const mainArtist = track.artist.split(",")[0].toLowerCase();
        const songTitle = track.name.toLowerCase();
    
        const isAutoGenerated =
          (videoDescription.includes("provided to youtube by") &&
            videoDescription.includes("auto-generated by youtube")) &&
          videoTitle.includes(songTitle);
    
        return isAutoGenerated;
      });
    
      if (autoGeneratedVideo) {
        console.log(
          "Selected Auto-Generated Video:",
          autoGeneratedVideo.snippet.title
        );
        return `https://www.youtube.com/watch?v=${autoGeneratedVideo.id.videoId}`;
      } else {
        // Fallback 우선순위: "filteredVideos"에서 첫 번째 비디오 선택
        const officialVideo = searchTargetVideos.find((item) =>
          item.snippet.title.toLowerCase().includes("official")
        );
    
        if (officialVideo) {
          console.log(
            "Selected Official Video as Fallback:",
            officialVideo.snippet.title
          );
          return `https://www.youtube.com/watch?v=${officialVideo.id.videoId}`;
        }
    
        const fallbackVideo = searchTargetVideos[0];
        console.log("Fallback YouTube Video:", fallbackVideo.snippet.title);
        return `https://www.youtube.com/watch?v=${fallbackVideo.id.videoId}`;
      }
    } else {
      throw new Error("YouTube에서 변환된 결과가 없습니다.");
    }
  } catch (error) {
    console.error("YouTube 변환 중 오류:", error);
    return null;
  }
};

// 플레이리스트 생성 함수
const createYouTubePlaylist = async (playlistName, videoIds) => {
  await ensureYouTubeAccessToken(); // Access Token 유효성 확인 및 갱신
  const youtube = google.youtube({
    version: "v3",
    auth: oauth2Client, // 인증된 OAuth2 클라이언트 사용
  });

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)); // 딜레이 함수 정의

  try {
    // 1. 새로운 플레이리스트 생성
    const playlistResponse = await youtube.playlists.insert({
      part: "snippet,status",
      requestBody: {
        snippet: { title: playlistName, description: "Generated by Playlist Converter" },
        status: { privacyStatus: "private" },
      },
    });

    const playlistId = playlistResponse.data.id;
    console.log("Created playlist with ID:", playlistId);

    // 2. 플레이리스트에 동영상 추가
    for (const videoId of videoIds) {
      try {
        await youtube.playlistItems.insert({
          part: "snippet",
          requestBody: {
            snippet: {
              playlistId: playlistId,
              resourceId: { kind: "youtube#video", videoId: videoId },
            },
          },
        });
        console.log(`Added video ${videoId} to playlist`);
        await sleep(1000); // 1초 딜레이 추가
      } catch (error) {
        console.error(`Failed to add video ${videoId} to playlist:`, error.message);
      }
    }

    return `https://www.youtube.com/playlist?list=${playlistId}`;
  } catch (error) {
    console.error("YouTube 플레이리스트 생성 중 오류:", error.message);
    throw new Error("YouTube 플레이리스트 생성 실패");
  }
};

// POST /convert API
app.post("/convert", async (req, res) => {
  const { sourcePlatform, destinationPlatform, playlistData } = req.body;

  try {
    if (sourcePlatform === 'spotify' && destinationPlatform === 'youtube') {
      // Step 1: 각 트랙을 YouTube 링크로 변환
      const youtubeLinks = [];
      for (const track of playlistData.tracks) {
        try {
          const link = await convertToYouTube(track);
          if (link) {
            youtubeLinks.push(link);
          } else {
            console.error(`Failed to convert track: ${track.name}`);
          }
        } catch (error) {
          console.error(`Error converting track ${track.name}: ${error.message}`);
        }
      }

      if (youtubeLinks.length === 0) {
        throw new Error("No valid YouTube links found for the playlist.");
      }

      // Step 2: YouTube Video IDs 추출
      const videoIds = youtubeLinks.map((link) => {
        const url = new URL(link);
        return url.searchParams.get('v');
      });

      // Step 3: YouTube 플레이리스트 생성
      const playlistUrl = await createYouTubePlaylist(
        playlistData.name,
        videoIds
      );

      res.json({ playlistUrl });
    } else {
      res.status(400).json({ error: "지원되지 않는 플랫폼 조합입니다." });
    }
  } catch (error) {
    console.error("플레이리스트 변환 중 오류:", error.message);
    res.status(500).json({ error: "플레이리스트 변환 중 오류가 발생했습니다." });
  }
});

// 서버 시작 시 Refresh Token 로드
if (fs.existsSync("refresh_token.json")) {
  const refreshToken = JSON.parse(fs.readFileSync("refresh_token.json", "utf8"));
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  console.log("Saved Refresh Token 로드 완료");
} else {
  console.log("Refresh Token 파일이 없습니다. /auth 경로로 인증을 진행하세요.");
}

// 인증 URL 생성
app.get('/auth', (req, res) => {
  const scopes = ['https://www.googleapis.com/auth/youtube'];
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline', // Refresh Token 요청
    prompt: 'consent', // 강제로 동의 화면 표시
    scope: scopes,
  });
  res.redirect(url);
});

// OAuth2 Callback 처리
app.get('/oauth2callback', async (req, res) => {
  const code = req.query.code;

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    console.log("Tokens received:", tokens);

    if (tokens.refresh_token) {
      // 현재 프로젝트 인덱스에 맞는 파일명으로 저장
      const refreshTokenPath = `refresh_token_project_${currentProjectIndex}.json`;
      fs.writeFileSync(refreshTokenPath, JSON.stringify(tokens.refresh_token));
      console.log(`Refresh Token 저장 완료: ${refreshTokenPath}`);
    } else {
      console.warn("Refresh Token이 반환되지 않았습니다.");
    }

    res.send("Authentication successful! You can close this window.");
  } catch (error) {
    console.error("OAuth 토큰 처리 중 오류:", error.message);
    res.status(500).send("Authentication failed.");
  }
});

const ensureYouTubeAccessToken = async () => {
  const tokens = oauth2Client.credentials;

  if (!tokens || !tokens.access_token) {
    console.log("YouTube Access Token이 설정되지 않았습니다. 갱신 시도 중...");
    try {
      const { credentials: refreshedTokens } = await oauth2Client.refreshAccessToken();
      oauth2Client.setCredentials(refreshedTokens);
      console.log("YouTube Access Token 갱신 완료:", refreshedTokens.access_token);
    } catch (error) {
      console.error("YouTube Access Token 갱신 중 오류:", error.message);
      throw new Error("Access Token 갱신 실패");
    }
  }

  // Access Token 만료 여부 확인
  if (tokens.expiry_date && tokens.expiry_date <= Date.now()) {
    console.log("YouTube Access Token 만료. 갱신 중...");
    try {
      const { credentials: refreshedTokens } = await oauth2Client.refreshAccessToken();
      oauth2Client.setCredentials(refreshedTokens);
      console.log("YouTube Access Token 갱신 완료:", refreshedTokens.access_token);
    } catch (error) {
      console.error("YouTube Access Token 갱신 중 오류:", error.message);
      throw new Error("Access Token 갱신 실패");
    }
  }
};

// 서버 실행
const PORT = 5001;
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});