# Wall

실시간 공유 그래피티 월(Graffiti Wall) 프로젝트입니다.  
`Next.js(App Router) + React + TypeScript + Socket.IO + custom Node server` 조합으로 동작하며, 여러 사용자가 동시에 같은 벽에 드로잉할 수 있습니다.

## 주요 기능

- 실시간 공동 드로잉 (`/draw`)
- 라이브 관람 화면 (`/wall`)
- 관리자 초기화 패널 (`/admin`)
- 모바일 에어마우스/터치 하이브리드 컨트롤러 (`/air`)
- 벽 상태(strokes) 파일 기반 영속화 (`data/wall-state.json`)
- 사용자별 Undo, 관리자 PIN 기반 Reset

## 기술 스택

- `Next.js 16` / `React 19`
- `TypeScript`
- `Socket.IO` / `socket.io-client`
- `ESLint` (`eslint-config-next`)
- 커스텀 서버: `server.js`

## 빠른 시작

### 1) 요구 사항

- `Node.js` 20+ 권장
- `npm`

### 2) 설치

```bash
npm install
```

### 3) 환경 변수 설정

`.env.example`을 참고해 `.env.local` 파일을 만드세요.

```bash
cp .env.example .env.local
```

필수/권장 변수:

- `ADMIN_PIN` (권장): `/admin`의 Reset 권한 보호용 PIN
- `PORT` (선택): 기본값 `3000`
- `ALLOWED_DEV_ORIGINS` (개발 모드 권장): 쉼표로 구분한 허용 origin 목록
- `USE_HTTPS` (선택): `1`이면 HTTPS로 서버 실행
- `SSL_KEY_PATH`, `SSL_CERT_PATH` (선택): HTTPS 인증서 경로

### 4) 개발 서버 실행

```bash
npm run dev
```

기본 접속 주소: `http://localhost:3000`

> 이 프로젝트의 `dev`는 `next dev`가 아니라 `node server.js`를 실행합니다.

### 5) 모바일 에어모드용 HTTPS(도메인 URL) 설정

iOS/Safari에서 모션 센서를 쓰려면 대부분 HTTPS가 필요합니다.

1. `mkcert` 설치 후 로컬 CA 준비
```bash
brew install mkcert
mkcert -install
```

2. 로컬 도메인 준비 (예: `wall.local`)

- 같은 네트워크에서 `wall.local`이 개발 PC IP를 가리키도록 DNS/hosts를 설정하세요.
- 테스트 기기(iPhone)에서도 같은 도메인으로 해석되어야 합니다.

3. 프로젝트에서 인증서 생성 (`wall.local`, `localhost` 포함)
```bash
mkdir -p certs
mkcert -key-file certs/wall.local-key.pem -cert-file certs/wall.local.pem wall.local localhost 127.0.0.1
```

4. `.env.local`에 HTTPS 설정
```env
USE_HTTPS=1
SSL_KEY_PATH=certs/wall.local-key.pem
SSL_CERT_PATH=certs/wall.local.pem
```

5. 서버 실행 후 모바일에서 접속
```text
https://wall.local:3000/air
```

## 스크립트

- `npm run dev`: 개발 서버 실행 (`node server.js`)
- `npm run build`: 프로덕션 빌드 (`next build`)
- `npm run start`: 프로덕션 서버 실행 (`NODE_ENV=production node server.js`)
- `npm run lint`: ESLint 검사

## 라우트

- `/` : `/draw`로 리다이렉트
- `/draw` : 드로잉 화면 (브러시/지우개/색상/사이즈/Undo)
- `/wall` : 관람 전용 화면 (실시간 상태 HUD)
- `/admin` : 벽 초기화(Reset) 관리 화면
- `/air` : 모바일 컨트롤러 화면 (Touchpad + Air mouse)

## 프로젝트 구조

```text
app/                # App Router 엔트리 및 페이지 라우트
  draw/page.tsx
  wall/page.tsx
  admin/page.tsx
components/         # UI 및 캔버스/소켓 로직
  GraffitiWall.tsx
  DrawStudio.tsx
  WallDisplay.tsx
  AdminPanel.tsx
lib/
  wall.ts           # 공용 타입/상수/헬퍼
data/
  wall-state.json   # 런타임 상태 저장 파일 (git ignore)
server.js           # custom Next + Socket.IO 서버
```

## 실시간 동작 개요

서버(`server.js`)가 Socket.IO 이벤트를 처리합니다.

- `wall:init`: 초기 strokes 및 상태 전달
- `stroke:begin` / `stroke:append` / `stroke:end`: 그리기 스트림 동기화
- `stroke:undo`: 동일 `userId` 기준 마지막 stroke 제거
- `wall:reset`: 관리자 PIN 검증 후 전체 초기화
- `wall:stats`: 온라인 수/스트로크 수 브로드캐스트

벽 데이터는 디바운스 후 `data/wall-state.json`에 저장되며, 서버 시작 시 로드됩니다.

## 보안/운영 주의사항

- `ADMIN_PIN` 미설정 시 `wall:reset`이 사실상 열려 있습니다. 운영 환경에서는 반드시 설정하세요.
- 현재 소켓 CORS 설정은 `origin: "*"`입니다. 외부 노출 환경에서는 제한 설정을 권장합니다.
- 기본 호스트 바인딩이 `0.0.0.0`이므로, 네트워크 노출 범위를 인지하고 운영하세요.
- `data/wall-state.json`, `.env.*`, `.next`는 `.gitignore`로 관리됩니다.

## 테스트 현황

- 현재 `package.json` 기준 별도 테스트 스크립트(`test`)는 정의되어 있지 않습니다.
- 최소한 `npm run lint`와 수동 시나리오(`/draw`, `/wall`, `/admin`) 검증을 권장합니다.
