import puppeteer from 'puppeteer'
import { writeFile } from 'node:fs/promises'
import { setTimeout } from 'node:timers/promises'

const loginUrl = 'https://secure.xserver.ne.jp/xapanel/login/xvps/' // XServer VPS のログイン画面 URL
const continueButtonText = '無料VPSの利用を継続する' // 更新確認や最終送信で押す主ボタンの文言
const loginButtonText = 'ログインする' // ログインフォーム送信ボタンの文言
const captchaImageSelector = 'img[src^="data:image"], img[src^="data:"]' // data URL 形式の CAPTCHA 画像を拾う selector
const captchaInputSelector = '[placeholder*="上の画像"]' // 画像 CAPTCHA の入力欄を拾う selector
const turnstileInputSelector = '[name="cf-turnstile-response"], [name="cf_challenge_response"]' // Turnstile token が入る hidden input の selector
const parsedTurnstileTimeoutMs = Number.parseInt(process.env.TURNSTILE_TIMEOUT_MS ?? '30000', 10) // 環境変数から読んだ Turnstile 待機時間の生値
const turnstileTimeoutMs = Number.isFinite(parsedTurnstileTimeoutMs) ? parsedTurnstileTimeoutMs : 30000 // Turnstile 自動生成を待つ実際のタイムアウト値
const parsedTurnstileSolverTimeoutMs = Number.parseInt(process.env.TURNSTILE_SOLVER_TIMEOUT_MS ?? '120000', 10) // 環境変数から読んだ solver 待機時間の生値
const turnstileSolverTimeoutMs = Number.isFinite(parsedTurnstileSolverTimeoutMs) ? parsedTurnstileSolverTimeoutMs : 120000 // solver から token が返るまで待つ実際のタイムアウト値
const turnstileSolverProvider = (process.env.TURNSTILE_SOLVER_PROVIDER || '2captcha').trim().toLowerCase() // 使う Turnstile solver の種別
const defaultBrowserUserAgent = process.env.BROWSER_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36' // 2Captcha と揃えやすい固定の送信用 User-Agent
const turnstileSolverApiKey = (
    process.env.TURNSTILE_SOLVER_API_KEY
    ?? process.env.TWOCAPTCHA_API_KEY
    ?? ''
).trim() // solver サービスへ接続するための API キー

const args = ['--no-sandbox', '--disable-setuid-sandbox'] // GitHub Actions 向けの Chrome 起動オプション
if (process.env.PROXY_SERVER) {
    const proxyUrl = new URL(process.env.PROXY_SERVER) // browser 起動時に渡す proxy URL
    proxyUrl.username = ''
    proxyUrl.password = ''
    args.push(`--proxy-server=${proxyUrl}`.replace(/\/$/, ''))
}

// 失敗時の HTML とスクリーンショットを artifact 用に保存する。
async function saveDebugArtifacts(page, prefix) {
    const safePrefix = prefix.replace(/[^a-z0-9-_]/gi, '-').toLowerCase() // ファイル名に使えるように整形した接頭辞
    await page.screenshot({ path: `debug-${safePrefix}.png`, fullPage: true }).catch(() => {})
    const html = await page.content().catch(() => '') // 失敗時点の DOM 全体
    if (html) {
        await writeFile(`debug-${safePrefix}.html`, html)
    }
}

// Turnstile の描画状態と token の有無をページ上から収集する。
async function getTurnstileState(page) {
    return page.evaluate((selector) => {
        const container = document.querySelector('.cf-turnstile') // Turnstile の描画コンテナ
        const input = document.querySelector(selector) // token を保持する hidden input
        const iframe = document.querySelector('iframe[src*="challenges.cloudflare.com"]') // 対話型 challenge が出る iframe
        const renderParams = globalThis.__turnstileRenderParams ?? {} // render hook で捕まえた sitekey などの引数

        return {
            url: window.location.href,
            userAgent: navigator.userAgent,
            hasContainer: Boolean(container),
            hasIframe: Boolean(iframe),
            hasInput: Boolean(input),
            tokenLength: input?.value?.length ?? 0,
            sitekey: renderParams.sitekey ?? container?.getAttribute('data-sitekey') ?? null,
            action: renderParams.action ?? container?.getAttribute('data-action') ?? null,
            cData: renderParams.cData ?? renderParams.cdata ?? container?.getAttribute('data-cdata') ?? null,
            chlPageData: renderParams.chlPageData ?? null,
            hasCallback: Boolean(globalThis.__turnstileCallback),
        }
    }, turnstileInputSelector)
}

// 更新確認ページに画像 CAPTCHA や Turnstile が出ているかをまとめて確認する。
async function getRenewalPageState(page) {
    return page.evaluate(({ imageSelector, inputSelector, turnstileSelector, submitText }) => {
        const input = document.querySelector(inputSelector) // CAPTCHA 入力欄
        const directImage = document.querySelector(imageSelector) // data URL で直に見えている CAPTCHA 画像
        const relatedImage = input
            ?.closest('form, table, section, article, div')
            ?.querySelector('img') // 入力欄の近くにある通常 URL の画像
        const image = directImage ?? relatedImage ?? null // 実際に使う CAPTCHA 画像候補
        const submitNode = Array.from(document.querySelectorAll('a, button, input[type="submit"], input[type="button"]'))
            .find(node => (node.textContent ?? node.value ?? '').includes(submitText)) // 続行に使えそうな送信要素

        return {
            url: window.location.href,
            title: document.title,
            hasCaptchaImage: Boolean(image?.src),
            captchaImageSourceKind: image?.src?.startsWith('data:') ? 'data-url' : (image?.src ? 'url' : null),
            hasCaptchaInput: Boolean(input),
            hasTurnstile: Boolean(
                document.querySelector('.cf-turnstile')
                || document.querySelector('iframe[src*="challenges.cloudflare.com"]')
                || document.querySelector(turnstileSelector)
            ),
            hasContinueButton: Boolean(submitNode),
            bodySnippet: document.body?.innerText?.replace(/\s+/g, ' ').slice(0, 300) ?? '',
        }
    }, {
        imageSelector: captchaImageSelector,
        inputSelector: captchaInputSelector,
        turnstileSelector: turnstileInputSelector,
        submitText: continueButtonText,
    })
}

// Turnstile hidden input に token が入るまで待機する。
async function waitForTurnstileToken(page, timeoutMs) {
    await page.waitForFunction((selector) => {
        const input = document.querySelector(selector) // hidden input に token が入ったかを見る
        return Boolean(input?.value && input.value.length > 20)
    }, { timeout: timeoutMs }, turnstileInputSelector)

    const token = await page.evaluate((selector) => document.querySelector(selector)?.value ?? '', turnstileInputSelector) // 取得済み token 本文
    console.log('Turnstile token received', token.length)
}

// Turnstile iframe が見えている場合に中央をクリックして発火を試みる。
async function clickTurnstileWidget(page) {
    const iframe = await page.$('iframe[src*="challenges.cloudflare.com"]') // challenge iframe の ElementHandle
    if (!iframe) {
        return false
    }

    await iframe.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'center' }))
    await setTimeout(1000)
    const box = await iframe.boundingBox() // クリック位置計算用の iframe 座標
    if (!box) {
        return false
    }

    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { delay: 100 })
    return true
}

// solver API との JSON 通信を共通化し、失敗時はレスポンスも含めて落とす。
async function requestJson(url, body) {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    }) // solver API への HTTP レスポンス
    const text = await response.text() // JSON 化前の生レスポンス
    let data
    try {
        data = JSON.parse(text)
    } catch {
        throw new Error(`Unexpected JSON response from ${url}: ${text.slice(0, 200)}`)
    }

    if (!response.ok) {
        throw new Error(`Request to ${url} failed with ${response.status}: ${text.slice(0, 200)}`)
    }

    return data
}

// 2Captcha に渡す Turnstile task を、必要なら proxy 情報付きで組み立てる。
function build2CaptchaTask(state) {
    const task = {
        type: 'TurnstileTaskProxyless',
        websiteURL: state.url,
        websiteKey: state.sitekey,
    } // 2Captcha に送る基本 task 情報

    if (state.action) {
        task.action = state.action
    }
    if (state.cData) {
        task.data = state.cData
    }
    if (state.chlPageData) {
        task.pagedata = state.chlPageData
    }
    if (state.userAgent) {
        task.userAgent = state.userAgent
    }

    if (!process.env.PROXY_SERVER) {
        return task
    }

    const proxy = new URL(process.env.PROXY_SERVER) // 2Captcha 側に渡す proxy 設定
    task.type = 'TurnstileTask'
    task.proxyType = proxy.protocol.replace(':', '') === 'https' ? 'http' : proxy.protocol.replace(':', '')
    task.proxyAddress = proxy.hostname
    task.proxyPort = Number.parseInt(proxy.port || (proxy.protocol === 'https:' ? '443' : '80'), 10)
    if (proxy.username) {
        task.proxyLogin = decodeURIComponent(proxy.username)
    }
    if (proxy.password) {
        task.proxyPassword = decodeURIComponent(proxy.password)
    }
    return task
}

// 2Captcha を使って Turnstile token を取得する。
async function solveTurnstile(page) {
    if (turnstileSolverProvider !== '2captcha') {
        throw new Error(`Unsupported TURNSTILE_SOLVER_PROVIDER: ${turnstileSolverProvider}`)
    }
    if (!turnstileSolverApiKey) {
        throw new Error('TURNSTILE_SOLVER_API_KEY is not set')
    }

    const state = await getTurnstileState(page) // solver に渡す前の Turnstile 状態
    if (!state.sitekey) {
        throw new Error(`Turnstile sitekey was not found: ${JSON.stringify(state)}`)
    }

    const createResult = await requestJson('https://api.2captcha.com/createTask', {
        clientKey: turnstileSolverApiKey,
        task: build2CaptchaTask(state),
    }) // 2Captcha に task を登録した結果
    if (createResult.errorId) {
        throw new Error(`2Captcha createTask failed: ${createResult.errorCode ?? createResult.errorDescription ?? createResult.errorId}`)
    }

    const deadline = Date.now() + turnstileSolverTimeoutMs // polling を打ち切る時刻
    while (Date.now() < deadline) {
        await setTimeout(5000)
        const result = await requestJson('https://api.2captcha.com/getTaskResult', {
            clientKey: turnstileSolverApiKey,
            taskId: createResult.taskId,
        }) // 2Captcha の polling 結果

        if (result.errorId) {
            throw new Error(`2Captcha getTaskResult failed: ${result.errorCode ?? result.errorDescription ?? result.errorId}`)
        }
        if (result.status === 'processing') {
            continue
        }
        if (result.status === 'ready' && result.solution?.token) {
            console.log('2Captcha solved Turnstile', {
                cost: result.cost,
                ip: result.ip,
                solveCount: result.solveCount,
                userAgent: result.solution.userAgent ?? null,
            })
            return {
                token: result.solution.token,
                userAgent: result.solution.userAgent ?? state.userAgent,
            }
        }

        throw new Error(`2Captcha returned unexpected status: ${JSON.stringify(result)}`)
    }

    throw new Error(`2Captcha timed out after ${turnstileSolverTimeoutMs}ms`)
}

// 取得した Turnstile token を hidden input と callback に注入する。
async function applyTurnstileToken(page, token) {
    await page.evaluate((value) => {
        const setFieldValue = (selector, name) => {
            let field = document.querySelector(selector)
            if (!field) {
                field = document.createElement('input')
                field.type = 'hidden'
                field.name = name
                ;(document.querySelector('form') ?? document.body).appendChild(field)
            }
            field.value = value
            field.dispatchEvent(new Event('input', { bubbles: true }))
            field.dispatchEvent(new Event('change', { bubbles: true }))
        } // 指定 input を作成または取得して token を流し込む helper

        setFieldValue('[name="cf-turnstile-response"]', 'cf-turnstile-response')
        setFieldValue('[name="g-recaptcha-response"]', 'g-recaptcha-response')

        if (typeof globalThis.__turnstileCallback === 'function') {
            globalThis.__turnstileCallback(value)
        }
    }, token)
}

// Turnstile を自動待機、クリック、solver の順で解決する。
async function ensureTurnstileReady(page) {
    const state = await getTurnstileState(page) // 現在の Turnstile 状態
    if (!state.hasContainer && !state.hasIframe && !state.hasInput) {
        console.log('Turnstile widget not found')
        return
    }
    if (state.tokenLength > 20) {
        console.log('Turnstile token already present', state.tokenLength)
        return
    }

    console.log('Waiting for Turnstile token', state)
    const firstWaitMs = Math.min(turnstileTimeoutMs, 5000) // まずは短時間だけ自動生成を待つ
    try {
        await waitForTurnstileToken(page, firstWaitMs)
        return
    } catch (error) {
        console.log('Turnstile token was not generated automatically', error.message)
    }

    if (await clickTurnstileWidget(page)) {
        console.log('Clicked Turnstile widget, waiting for token again')
    } else {
        console.log('Turnstile widget click was not available')
    }

    try {
        await waitForTurnstileToken(page, turnstileTimeoutMs)
    } catch {
        console.log('Turnstile token was still unavailable', await getTurnstileState(page))
        const solution = await solveTurnstile(page) // solver が返した token と UA
        if (solution.userAgent) {
            await page.setUserAgent(solution.userAgent)
            console.log('Updated browser user agent to solver value', solution.userAgent)
        }
        await applyTurnstileToken(page, solution.token)
        console.log('Injected Turnstile token from solver')
    }
}

// 送信前後の比較に使うため、現在のページ状態をスナップショットとして保存する。
async function getPageChangeSnapshot(page) {
    return page.evaluate(({ imageSelector, inputSelector, turnstileSelector }) => {
        const image = document.querySelector(imageSelector)
        const input = document.querySelector(inputSelector)
        const turnstileInput = document.querySelector(turnstileSelector)

        return {
            url: window.location.href,
            title: document.title,
            captchaSrc: image?.src ?? null,
            captchaValue: input?.value ?? '',
            turnstileValue: turnstileInput?.value ?? '',
            bodySnippet: document.body?.innerText?.replace(/\s+/g, ' ').slice(0, 400) ?? '',
        }
    }, {
        imageSelector: captchaImageSelector,
        inputSelector: captchaInputSelector,
        turnstileSelector: turnstileInputSelector,
    })
}

// 送信後に POST や DOM 変化が起きたかを把握するための診断情報を収集する。
async function getSubmitDiagnostics(page) {
    return page.evaluate(({ inputSelector, turnstileSelector, buttonText }) => {
        const input = document.querySelector(inputSelector)
        const turnstileInput = document.querySelector(turnstileSelector)
        const submitButton = Array.from(document.querySelectorAll('input[type="submit"], input[type="button"], button, a'))
            .find(node => (node.textContent ?? node.value ?? '').includes(buttonText))
        const form = input?.closest('form') ?? submitButton?.closest('form') ?? document.querySelector('form')
        const messages = Array.from(document.querySelectorAll('.error, .alert, .warning, .notice, .message, .formError'))
            .map(node => node.textContent?.trim())
            .filter(Boolean)

        return {
            url: window.location.href,
            title: document.title,
            formAction: form?.action ?? null,
            formMethod: form?.method ?? null,
            captchaValue: input?.value ?? '',
            turnstileTokenLength: turnstileInput?.value?.length ?? 0,
            submitButtonDisabled: Boolean(submitButton?.disabled),
            messages,
            bodySnippet: document.body?.innerText?.replace(/\s+/g, ' ').slice(0, 600) ?? '',
        }
    }, {
        inputSelector: captchaInputSelector,
        turnstileSelector: turnstileInputSelector,
        buttonText: continueButtonText,
    })
}

// 送信や遷移のあとに、送信前スナップショットとの差分が出るまで短時間待つ。
async function waitForPotentialPageChange(page, previousSnapshot, timeoutMs = 10000) {
    try {
        await page.waitForFunction((snapshot, imageSelector, inputSelector, turnstileSelector) => {
            const image = document.querySelector(imageSelector)
            const input = document.querySelector(inputSelector)
            const turnstileInput = document.querySelector(turnstileSelector)
            const bodySnippet = document.body?.innerText?.replace(/\s+/g, ' ').slice(0, 400) ?? ''

            return (
                window.location.href !== snapshot.url
                || document.title !== snapshot.title
                || (image?.src ?? null) !== snapshot.captchaSrc
                || (input?.value ?? '') !== snapshot.captchaValue
                || (turnstileInput?.value ?? '') !== snapshot.turnstileValue
                || bodySnippet !== snapshot.bodySnippet
            )
        }, { timeout: timeoutMs }, previousSnapshot, captchaImageSelector, captchaInputSelector, turnstileInputSelector)
        return true
    } catch {
        // Let the next state check decide whether we progressed.
        return false
    }
}

// 続行ボタンを通常 click し、だめなら DOM 直叩きで submit する。
async function clickContinueButton(page, reason) {
    console.log('Clicking continue button', reason)
    try {
        await page.locator(`text=${continueButtonText}`).click({ timeout: 5000 })
        return
    } catch (error) {
        console.log('Locator click failed, falling back to DOM submit', error.message)
    }

    const submitMode = await page.evaluate((text, inputSelector) => {
        if (typeof globalThis.submit_button !== 'undefined'
            && globalThis.submit_button
            && typeof globalThis.submit_button.click === 'function') {
            globalThis.submit_button.click()
            return 'global-submit-button'
        }

        const candidates = Array.from(document.querySelectorAll('input[type="submit"], input[type="button"], button, a')) // submit 候補の DOM 一覧
        const target = candidates.find(node => (node.textContent ?? node.value ?? '').includes(text)) // 文言が一致する送信候補
        if (target && typeof target.click === 'function') {
            target.click()
            return 'matched-node'
        }

        const form = document.querySelector(inputSelector)?.closest('form') ?? document.querySelector('form') // 最後に直接 submit を試す対象 form
        if (form?.requestSubmit) {
            form.requestSubmit()
            return 'request-submit'
        }
        if (form?.submit) {
            form.submit()
            return 'direct-submit'
        }

        return null
    }, continueButtonText, captchaInputSelector)

    if (!submitMode) {
        throw new Error('Could not find any way to submit the renewal form')
    }

    console.log('Continue button fallback used', submitMode)
}

// CAPTCHA 画像を data URL で取り出し、必要なら通常 URL から読み直す。
async function getCaptchaImageBody(page) {
    return page.evaluate(async ({ imageSelector, inputSelector }) => {
        const findImage = () => {
            const directImage = document.querySelector(imageSelector) // data URL 形式で出ている CAPTCHA 画像
            if (directImage?.src) {
                return directImage
            }

            const input = document.querySelector(inputSelector) // 入力欄の近くから画像を探すための基点
            if (!input) {
                return null
            }

            const container = input.closest('form, table, section, article, div') ?? document // 入力欄を含む周辺コンテナ
            return container.querySelector('img')
        }

        const image = findImage() // 実際に使う CAPTCHA 画像要素
        if (!image?.src) {
            return null
        }
        if (image.src.startsWith('data:')) {
            return image.src
        }

        const response = await fetch(image.src, { credentials: 'include' }) // 通常 URL 画像を cookie 付きで取得
        if (!response.ok) {
            throw new Error(`Failed to fetch CAPTCHA image: ${response.status}`)
        }

        const blob = await response.blob() // FileReader で data URL 化するための blob
        return new Promise((resolve, reject) => {
            const reader = new FileReader() // blob を data URL に変換する reader
            reader.onerror = () => reject(new Error('Failed to convert CAPTCHA image to data URL'))
            reader.onloadend = () => resolve(reader.result)
            reader.readAsDataURL(blob)
        })
    }, {
        imageSelector: captchaImageSelector,
        inputSelector: captchaInputSelector,
    })
}

// 更新ページで画像 CAPTCHA が出るまで、Turnstile 解決や再送信を挟みながら待つ。
async function waitForRenewalCaptcha(page) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const state = await getRenewalPageState(page) // 各試行時点の更新ページ状態
        console.log('Renewal page state', { attempt, ...state })

        if (state.hasCaptchaImage && state.hasCaptchaInput) {
            return
        }

        if (state.hasTurnstile) {
            await ensureTurnstileReady(page)
            if (!state.hasCaptchaImage && state.hasContinueButton) {
                const previousSnapshot = await getPageChangeSnapshot(page) // 送信前のページ状態
                await clickContinueButton(page, 'advance after Turnstile')
                await waitForPotentialPageChange(page, previousSnapshot)
                continue
            }
        }

        if (state.hasContinueButton && !state.hasCaptchaImage) {
            const previousSnapshot = await getPageChangeSnapshot(page) // 再送信前のページ状態
            await clickContinueButton(page, 'retry until CAPTCHA image is visible')
            await waitForPotentialPageChange(page, previousSnapshot)
            continue
        }

        await setTimeout(3000)
    }

    await saveDebugArtifacts(page, 'renewal-page-missing-captcha')
    throw new Error(`Verification page did not expose the CAPTCHA image: ${JSON.stringify(await getRenewalPageState(page))}`)
}

const browser = await puppeteer.launch({
    defaultViewport: { width: 1080, height: 1024 },
    args,
}) // 自動操作に使う Chromium ブラウザ
const [page] = await browser.pages() // 最初のタブ
await page.setUserAgent(defaultBrowserUserAgent)
await page.setExtraHTTPHeaders({ 'accept-language': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7' })
await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    Object.defineProperty(navigator, 'language', { get: () => 'ja-JP' })
    Object.defineProperty(navigator, 'languages', { get: () => ['ja-JP', 'ja', 'en-US', 'en'] })
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' })

    // Turnstile の render 引数を横取りして sitekey や callback を保持する。
    const installTurnstileHook = () => {
        if (!globalThis.turnstile || typeof globalThis.turnstile.render !== 'function' || globalThis.turnstile.__codexHookInstalled) {
            return false
        }

        const originalRender = globalThis.turnstile.render.bind(globalThis.turnstile) // 元の render 実装
        globalThis.turnstile.render = (container, params = {}) => {
            globalThis.__turnstileRenderParams = {
                sitekey: params.sitekey ?? null,
                action: params.action ?? null,
                cData: params.cData ?? params.cdata ?? null,
                chlPageData: params.chlPageData ?? null,
            }
            if (typeof params.callback === 'function') {
                globalThis.__turnstileCallback = params.callback
            }
            return originalRender(container, params)
        }
        globalThis.turnstile.__codexHookInstalled = true
        return true
    }

    installTurnstileHook()
    const hookTimer = setInterval(() => {
        if (installTurnstileHook()) {
            clearInterval(hookTimer)
        }
    }, 50) // Turnstile 読み込み完了まで短周期で hook を試すタイマー
})
const recorder = await page.screencast({ path: 'recording.webm' }) // 実行中の画面録画

try {
    if (process.env.PROXY_SERVER) {
        const { username, password } = new URL(process.env.PROXY_SERVER) // proxy 認証に使う資格情報
        if (username && password) {
            await page.authenticate({ username, password })
        }
    }

    await page.goto(loginUrl, { waitUntil: 'networkidle2' })
    await page.locator('#memberid').fill(process.env.EMAIL)
    await page.locator('#user_password').fill(process.env.PASSWORD)
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2' }),
        page.locator(`text=${loginButtonText}`).click(),
    ])
    await page.locator('a[href^="/xapanel/xvps/server/detail?id="]').click()
    await page.locator('text=更新する').click()
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {}),
        page.locator(`text=${continueButtonText}`).click(),
    ])

    await waitForRenewalCaptcha(page)

    const body = await getCaptchaImageBody(page) // 認識 API に渡す CAPTCHA 画像の data URL
    if (!body) {
        await saveDebugArtifacts(page, 'captcha-image-missing')
        throw new Error(`Captcha image is still missing after waiting: ${JSON.stringify(await getRenewalPageState(page))}`)
    }

    const code = await fetch('https://captcha-120546510085.asia-northeast1.run.app', {
        method: 'POST',
        body,
        headers: { 'content-type': 'text/plain' },
    }).then(response => response.text()) // 外部 API が返した CAPTCHA 認識結果

    console.log('Captcha recognition result', code.trim())
    await page.locator(captchaInputSelector).fill(code.trim())
    await ensureTurnstileReady(page)
    const previousSnapshot = await getPageChangeSnapshot(page) // 最終 submit 前のページ状態
    const navigationPromise = page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).then(() => ({
        happened: true,
        url: page.url(),
    })).catch(() => null)
    const requestPromise = page.waitForRequest(request => (
        request.method() === 'POST'
        && request.url().includes('/xapanel/xvps/server/freevps/extend/')
    ), { timeout: 15000 }).then(request => ({
        happened: true,
        url: request.url(),
        method: request.method(),
    })).catch(() => null)
    await clickContinueButton(page, 'submit renewal form')
    const pageChanged = await waitForPotentialPageChange(page, previousSnapshot, 15000)
    const submitRequest = await requestPromise
    const navigationResult = await navigationPromise
    console.log('Submit observation', { pageChanged, submitRequest, navigationResult })
    console.log('Post-submit state', await getRenewalPageState(page))
    console.log('Post-submit diagnostics', await getSubmitDiagnostics(page))
} catch (error) {
    await saveDebugArtifacts(page, 'main-error')
    console.error(error)
    process.exitCode = 1
} finally {
    await setTimeout(5000)
    await recorder.stop()
    await browser.close()
}
