# DOWN 시세 트래커

K2 구스·덕다운 원자재 시세와 중국우모공업협회 참고 시세를 보여주는 정적 GitHub Pages 사이트입니다.

## 자동 갱신

- 로컬 Windows 예약 작업: 월·화·수·금 09:00(Asia/Seoul). 해당 주에 한 번 성공하면 나머지 실행은 건너뛰고 다음 주 월요일에 다시 시작
- GitHub Actions 보완 실행: 매주 월요일 09:30(Asia/Seoul)
- 배포: `main` 브랜치의 `index.html`을 GitHub Pages가 자동 게시

로컬 예약 작업은 `DOWN 가격동향 계속~ - 복사본.xlsx`의 최신 내용을 읽고 중국 시세와 환율을 수집한 뒤 생성 파일을 검증하여 `main`에 푸시합니다. 월요일에 컴퓨터가 꺼져 있거나 실행이 실패하면 화요일, 수요일, 금요일 순서로 재시도합니다. 성공 기록은 `logs/last-success.json`에 저장되며, 성공 후에는 같은 주의 나머지 실행을 건너뜁니다. GitHub Actions는 저장소에 마지막으로 올라온 엑셀을 기준으로 중국 시세와 환율 갱신을 보완합니다.

수동 실행:

```powershell
node scripts/update-site.mjs
```

쓰기 없이 검증:

```powershell
node scripts/update-site.mjs --dry-run --skip-network
```
