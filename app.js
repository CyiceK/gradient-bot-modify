const { Builder, By, until, Capabilities } = require("selenium-webdriver")
const chrome = require("selenium-webdriver/chrome")
const url = require("url")
const fs = require("fs")
const crypto = require("crypto")
const axios = require("axios")
const path = require("path")
const FormData = require("form-data")
const proxy = require("selenium-webdriver/proxy")
const proxyChain = require("proxy-chain")
const express = require("express")
require('console-stamp')(console, {
  format: ':date(yyyy/mm/dd HH:MM:ss.l)'
})
require("dotenv").config()

const extensionId = "caacbgbklghmpodbdafajbgdnegacfmo"
// 扩展下载使用本地网络，不通过代理
const CRX_URL = `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=98.0.4758.102&acceptformat=crx2,crx3&x=id%3D${extensionId}%26uc&nacl_arch=x86-64`
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.102 Safari/537.36"

const USER = process.env.APP_USER || ""
const PASSWORD = process.env.APP_PASS || ""
const ALLOW_DEBUG = !!process.env.DEBUG?.length || false
const EXTENSION_FILENAME = "app.crx"
const PROXY = process.env.PROXY || undefined

console.log("-> Starting...")
console.log("-> User:", USER)
console.log("-> Pass:", PASSWORD)
console.log("-> Proxy:", PROXY)
console.log("-> Debug:", ALLOW_DEBUG)

if (!USER || !PASSWORD) {
  console.error("Please set APP_USER and APP_PASS env variables")
  process.exit()
}

if (ALLOW_DEBUG) {
  console.log(
    "-> Debugging is enabled! This will generate a screenshot and console logs on error!"
  )
}

async function downloadExtension(extensionId) {
  const downloadUrl = CRX_URL.replace(extensionId, extensionId)
  const headers = { "User-Agent": USER_AGENT }

  console.log("-> Downloading extension from:", downloadUrl)

  // if file exists and modify time is less than 1 day, skip download
  if (fs.existsSync(EXTENSION_FILENAME) && fs.statSync(EXTENSION_FILENAME).mtime > Date.now() - 86400000) {
    console.log("-> Extension already downloaded! skip download...")
    return
  }

  try {
    // 使用axios替换request，确保本地网络下载
    const response = await axios({
      method: 'GET',
      url: downloadUrl,
      headers: headers,
      responseType: 'arraybuffer',
      timeout: 30000, // 30秒超时
      proxy: false, // 明确禁用代理
      maxRedirects: 5,
      validateStatus: function (status) {
        return status >= 200 && status < 300
      }
    })

    // 验证响应
    if (!response.data || response.data.length === 0) {
      throw new Error('Empty response received')
    }

    // 写入文件
    fs.writeFileSync(EXTENSION_FILENAME, Buffer.from(response.data))

    if (ALLOW_DEBUG) {
      const md5 = crypto.createHash("md5").update(Buffer.from(response.data)).digest("hex")
      console.log("-> Extension MD5: " + md5)
      console.log("-> Extension size: " + response.data.byteLength + " bytes")
    }

    console.log("-> Extension downloaded successfully using local network!")
  } catch (error) {
    console.error("Error downloading extension:", error.message)

    // 详细错误处理
    if (error.code === 'ECONNABORTED') {
      throw new Error('Extension download timeout - please check network connection')
    } else if (error.response) {
      throw new Error(`Extension download failed with status ${error.response.status}: ${error.response.statusText}`)
    } else if (error.request) {
      throw new Error('Extension download failed - no response received')
    } else {
      throw new Error(`Extension download failed: ${error.message}`)
    }
  }
}

// 资源管理器类 - 防止内存泄漏
class ResourceManager {
  constructor() {
    this.memoryThreshold = 512 * 1024 * 1024 // 512MB
    this.monitorInterval = 60000 // 1分钟检查
    this.restartThreshold = 0.9 // 90%内存使用率
    this.intervalId = null
    this.state = {
      startTime: Date.now(),
      lastMemoryCheck: Date.now(),
      restartCount: 0
    }
  }

  startMonitoring() {
    console.log("-> Starting resource monitoring...")
    this.intervalId = setInterval(() => {
      this.checkMemoryUsage()
    }, this.monitorInterval)
  }

  checkMemoryUsage() {
    const memUsage = process.memoryUsage()
    const memPercent = memUsage.heapUsed / this.memoryThreshold

    console.log(`-> Memory usage: ${(memPercent * 100).toFixed(2)}% (${(memUsage.heapUsed / 1024 / 1024).toFixed(2)}MB)`)

    // 记录内存使用历史
    this.state.lastMemoryCheck = Date.now()

    if (memPercent > this.restartThreshold) {
      console.log('-> Memory threshold exceeded, triggering graceful restart...')
      this.triggerGracefulRestart()
    }

    // 强制垃圾回收（如果可用）
    if (global.gc) {
      global.gc()
      console.log('-> Forced garbage collection')
    }
  }

  async saveState() {
    try {
      const stateData = {
        ...this.state,
        timestamp: Date.now(),
        memoryUsage: process.memoryUsage()
      }
      fs.writeFileSync('app-state.json', JSON.stringify(stateData, null, 2))
      console.log('-> Application state saved')
    } catch (error) {
      console.error('-> Failed to save state:', error.message)
    }
  }

  async cleanup() {
    console.log('-> Starting resource cleanup...')

    // 清理定时器
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }

    // 清理其他全局资源
    if (global.driver) {
      try {
        await global.driver.quit()
        console.log('-> WebDriver cleaned up')
      } catch (error) {
        console.error('-> Error cleaning up WebDriver:', error.message)
      }
    }

    console.log('-> Resource cleanup completed')
  }

  async triggerGracefulRestart() {
    try {
      // 保存当前状态
      await this.saveState()

      // 清理资源
      await this.cleanup()

      // 增加重启计数
      this.state.restartCount++

      console.log(`-> Graceful restart initiated (restart #${this.state.restartCount})`)

      // 重启进程 - PM2会自动重启
      process.exit(0)
    } catch (error) {
      console.error('-> Error during graceful restart:', error.message)
      process.exit(1)
    }
  }

  stopMonitoring() {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
      console.log('-> Resource monitoring stopped')
    }
  }
}

// 创建全局资源管理器实例
const resourceManager = new ResourceManager()

// 反检测系统类
class AntiDetectionSystem {
  constructor() {
    this.userAgents = [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ]

    this.windowSizes = [
      [1920, 1080], [1366, 768], [1536, 864], [1440, 900], [1280, 720]
    ]

    this.behaviorPatterns = {
      clickDelay: [100, 500], // 随机点击延迟 100-500ms
      scrollSpeed: [50, 200], // 随机滚动速度
      idleTime: [30000, 120000], // 随机空闲时间 30-120秒
      typingDelay: [50, 150] // 打字延迟 50-150ms
    }
  }

  getRandomUserAgent() {
    return this.userAgents[Math.floor(Math.random() * this.userAgents.length)]
  }

  getRandomWindowSize() {
    const size = this.windowSizes[Math.floor(Math.random() * this.windowSizes.length)]
    return `${size[0]},${size[1]}`
  }

  getRandomDelay(range) {
    const [min, max] = range
    return Math.floor(Math.random() * (max - min + 1)) + min
  }

  async simulateHumanBehavior(driver) {
    try {
      console.log("-> Simulating human behavior...")

      // 随机鼠标移动
      await this.randomMouseMovement(driver)

      // 随机滚动
      await this.randomScroll(driver)

      // 随机等待
      const waitTime = this.getRandomDelay(this.behaviorPatterns.idleTime)
      console.log(`-> Random idle time: ${waitTime}ms`)
      await new Promise(resolve => setTimeout(resolve, waitTime))

    } catch (error) {
      console.log("-> Human behavior simulation failed:", error.message)
    }
  }

  async randomMouseMovement(driver) {
    try {
      // 获取窗口大小
      const windowSize = await driver.manage().window().getSize()

      // 生成随机坐标
      const x = Math.floor(Math.random() * windowSize.width)
      const y = Math.floor(Math.random() * windowSize.height)

      // 执行鼠标移动
      await driver.executeScript(`
        const event = new MouseEvent('mousemove', {
          clientX: ${x},
          clientY: ${y},
          bubbles: true
        });
        document.dispatchEvent(event);
      `)

      console.log(`-> Random mouse movement to (${x}, ${y})`)
    } catch (error) {
      console.log("-> Mouse movement simulation failed:", error.message)
    }
  }

  async randomScroll(driver) {
    try {
      const scrollAmount = Math.floor(Math.random() * 500) + 100 // 100-600px
      const direction = Math.random() > 0.5 ? 1 : -1 // 上或下

      await driver.executeScript(`
        window.scrollBy(0, ${scrollAmount * direction});
      `)

      console.log(`-> Random scroll: ${scrollAmount * direction}px`)

      // 滚动后等待
      await new Promise(resolve => setTimeout(resolve, this.getRandomDelay([500, 1500])))
    } catch (error) {
      console.log("-> Scroll simulation failed:", error.message)
    }
  }

  async simulateTyping(element, text) {
    try {
      // 清空输入框
      await element.clear()

      // 逐字符输入，模拟真实打字
      for (let char of text) {
        await element.sendKeys(char)
        const delay = this.getRandomDelay(this.behaviorPatterns.typingDelay)
        await new Promise(resolve => setTimeout(resolve, delay))
      }

      console.log("-> Simulated human typing")
    } catch (error) {
      console.log("-> Typing simulation failed:", error.message)
      // 降级到普通输入
      await element.sendKeys(text)
    }
  }

  setupBrowserFingerprint(options) {
    console.log("-> Setting up anti-detection browser fingerprint...")

    // 随机User-Agent
    const userAgent = this.getRandomUserAgent()
    options.addArguments(`--user-agent=${userAgent}`)
    console.log("-> Random User-Agent:", userAgent)

    // 随机窗口大小
    const windowSize = this.getRandomWindowSize()
    options.addArguments(`--window-size=${windowSize}`)
    console.log("-> Random window size:", windowSize)

    // 禁用自动化检测
    options.addArguments('--disable-blink-features=AutomationControlled')
    options.setExperimentalOption("excludeSwitches", ["enable-automation"])
    options.setExperimentalOption('useAutomationExtension', false)

    // 禁用开发者工具检测
    options.addArguments('--disable-dev-shm-usage')
    options.addArguments('--disable-extensions-except')
    options.addArguments('--disable-plugins-discovery')

    // 随机化其他指纹
    options.addArguments('--disable-default-apps')
    options.addArguments('--no-first-run')
    options.addArguments('--no-default-browser-check')

    return options
  }

  async injectAntiDetectionScripts(driver) {
    try {
      console.log("-> Injecting anti-detection scripts...")

      // 隐藏webdriver属性
      await driver.executeScript(`
        Object.defineProperty(navigator, 'webdriver', {
          get: () => undefined,
        });
      `)

      // 修改plugins
      await driver.executeScript(`
        Object.defineProperty(navigator, 'plugins', {
          get: () => [1, 2, 3, 4, 5],
        });
      `)

      // 修改languages
      await driver.executeScript(`
        Object.defineProperty(navigator, 'languages', {
          get: () => ['en-US', 'en'],
        });
      `)

      console.log("-> Anti-detection scripts injected successfully")
    } catch (error) {
      console.log("-> Failed to inject anti-detection scripts:", error.message)
    }
  }
}

// 创建全局反检测系统实例
const antiDetectionSystem = new AntiDetectionSystem()

async function takeScreenshot(driver, filename) {
  // if ALLOW_DEBUG is set, taking screenshot
  if (!ALLOW_DEBUG) {
    return
  }

  const data = await driver.takeScreenshot()
  fs.writeFileSync(filename, Buffer.from(data, "base64"))
}

async function generateErrorReport(driver) {
  //write dom
  const dom = await driver.findElement(By.css("html")).getAttribute("outerHTML")
  fs.writeFileSync("error.html", dom)

  await takeScreenshot(driver, "error.png")

  const logs = await driver.manage().logs().get("browser")
  fs.writeFileSync(
    "error.log",
    logs.map((log) => `${log.level.name}: ${log.message}`).join("\n")
  )
}

async function getDriverOptions() {
  const options = new chrome.Options()

  // 应用反检测系统配置
  antiDetectionSystem.setupBrowserFingerprint(options)

  options.addArguments("--headless")
  options.addArguments("--single-process")
  options.addArguments("--remote-allow-origins=*")
  options.addArguments("--disable-dev-shm-usage")
  // options.addArguments("--incognito")
  options.addArguments("--start-maximized")
  options.addArguments("--disable-renderer-backgrounding")
  options.addArguments("--disable-background-timer-throttling")
  options.addArguments("--disable-backgrounding-occluded-windows")
  options.addArguments("--disable-low-res-tiling")
  options.addArguments("--disable-client-side-phishing-detection")
  options.addArguments("--disable-crash-reporter")
  options.addArguments("--disable-oopr-debug-crash-dump")
  options.addArguments("--disable-infobars")
  options.addArguments("--dns-prefetch-disable")
  options.addArguments("--disable-crash-reporter")
  options.addArguments("--disable-in-process-stack-traces")
  options.addArguments("--disable-popup-blocking")
  options.addArguments("--disable-gpu")
  options.addArguments("--disable-web-security")
  options.addArguments("--disable-default-apps")
  options.addArguments("--ignore-certificate-errors")
  options.addArguments("--ignore-ssl-errors")
  options.addArguments("--no-sandbox")
  options.addArguments("--no-crash-upload")
  options.addArguments("--no-zygote")
  options.addArguments("--no-first-run")
  options.addArguments("--no-default-browser-check")
  options.addArguments("--remote-allow-origins=*")
  options.addArguments("--allow-running-insecure-content")
  options.addArguments("--enable-unsafe-swiftshader")

  if (!ALLOW_DEBUG) {
    // options.addArguments("--blink-settings=imagesEnabled=false")
  }

  if (PROXY) {
    console.log("-> Setting up proxy...", PROXY)

    try {
      let proxyUrl = PROXY

      // if no scheme, add http://
      if (!proxyUrl.includes("://")) {
        proxyUrl = `http://${proxyUrl}`
      }

      // 添加超时处理，避免代理链处理卡住
      const proxyPromise = proxyChain.anonymizeProxy(proxyUrl)
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Proxy setup timeout')), 10000)
      )

      const newProxyUrl = await Promise.race([proxyPromise, timeoutPromise])

      console.log("-> New proxy URL:", newProxyUrl)

      options.setProxy(
        proxy.manual({
          http: newProxyUrl,
          https: newProxyUrl,
        })
      )
      const url = new URL(newProxyUrl)
      console.log("-> Proxy host:", url.hostname)
      console.log("-> Proxy port:", url.port)
      options.addArguments(`--proxy-server=socks5://${url.hostname}:${url.port}`)
      console.log("-> Setting up proxy done!")
    } catch (error) {
      console.error("-> Proxy setup failed:", error.message)
      console.log("-> Continuing without proxy...")
      // 不抛出错误，继续执行
    }
  } else {
    console.log("-> No proxy set!")
  }

  return options
}

async function getProxyIpInfo(driver, proxyUrl) {
  // const url = "https://httpbin.org/ip"
  const url = "https://myip.ipip.net"

  console.log("-> Getting proxy IP info:", proxyUrl)

  try {
    // 设置更短的超时时间，避免长时间卡住
    await driver.manage().setTimeouts({ pageLoad: 15000, script: 15000 })
    await driver.get(url)
    await driver.wait(until.elementLocated(By.css("body")), 15000)
    const pageText = await driver.findElement(By.css("body")).getText()
    console.log("-> Proxy IP info:", pageText)
  } catch (error) {
    console.error("-> Failed to get proxy IP info:", error)
    throw new Error("Failed to get proxy IP info!")
  }
}

(async () => {
  try {
    // 启动资源监控
    resourceManager.startMonitoring()

    await downloadExtension(extensionId)

    const options = await getDriverOptions()

    options.addExtensions(path.resolve(__dirname, EXTENSION_FILENAME))

    console.log(`-> Extension added! ${EXTENSION_FILENAME}`)

    // enable debug
    if (ALLOW_DEBUG) {
      options.addArguments("--enable-logging")
      options.addArguments("--v=1")
    }

    let driver
    try {
      console.log("-> Starting browser...")

      driver = await new Builder()
        .forBrowser("chrome")
        .setChromeOptions(options)
        .build()

      // 保存driver到全局变量，供资源管理器使用
      global.driver = driver

      console.log("-> Browser started!")

      // 注入反检测脚本
      await antiDetectionSystem.injectAntiDetectionScripts(driver)

    // 设置全局超时，防止各种操作卡住
    await driver.manage().setTimeouts({
      implicit: 10000,      // 隐式等待10秒
      pageLoad: 30000,      // 页面加载30秒
      script: 30000         // 脚本执行30秒
    })

    if (PROXY) {
      try {
        // 添加重试机制，最多重试10次
        let retryCount = 0
        const maxRetries = 10
        let success = false

        while (retryCount < maxRetries && !success) {
          try {
            await getProxyIpInfo(driver, PROXY)
            success = true // 成功标记
            retryCount = 0 // 成功后清空重试次数
            console.log("-> Proxy check successful!")
            break // 成功则跳出循环
          } catch (error) {
            retryCount++
            console.log(`-> Proxy check failed (attempt ${retryCount}/${maxRetries}):`, error.message)

            if (retryCount >= maxRetries) {
              console.log("-> Proxy check failed after all retries, continuing anyway...")
              console.log(`-> Please check the proxy manually: curl -vv -x ${PROXY} https://myip.ipip.net`)
              break // 不抛出错误，继续执行
            }

            // 渐进式延迟：第1次等待2秒，第2次等待4秒，第3次等待6秒，最多10秒
            const delaySeconds = Math.min(retryCount * 2, 10)
            console.log(`-> Waiting ${delaySeconds} seconds before retry...`)
            await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000))
          }
        }

        if (success) {
          console.log("-> Proxy validation completed successfully")
        }
      } catch (error) {
        console.error("-> Proxy validation error:", error.message)
        console.log("-> Continuing without proxy validation...")
      }
    }

    console.log("-> Started! Logging in https://app.gradient.network/...")
    await driver.get("https://app.gradient.network/")

    const emailInput = By.css('[placeholder="Enter Email"]')
    const passwordInput = By.css('[type="password"]')
    const loginButton = By.css("button")

    await driver.wait(until.elementLocated(emailInput), 30000)
    await driver.wait(until.elementLocated(passwordInput), 30000)
    await driver.wait(until.elementLocated(loginButton), 30000)

    // 使用反检测系统模拟人类输入
    const emailElement = await driver.findElement(emailInput)
    const passwordElement = await driver.findElement(passwordInput)

    await antiDetectionSystem.simulateTyping(emailElement, USER)
    await new Promise(resolve => setTimeout(resolve, antiDetectionSystem.getRandomDelay([500, 1500])))

    await antiDetectionSystem.simulateTyping(passwordElement, PASSWORD)
    await new Promise(resolve => setTimeout(resolve, antiDetectionSystem.getRandomDelay([500, 1500])))

    // 模拟人类行为后点击
    await antiDetectionSystem.simulateHumanBehavior(driver)
    await driver.findElement(loginButton).click()

    // wait until find <a href="/dashboard/setting">
    await driver.wait(until.elementLocated(By.css('a[href="/dashboard/setting"]')), 30000)

    console.log("-> Logged in! Waiting for open extension...")

    // 截图登录状态
    takeScreenshot(driver, "logined.png")

    await driver.get(`chrome-extension://${extensionId}/popup.html`)

    console.log("-> Extension opened!")

    // 直到找到 "Status" 文本的 div 元素
    await driver.wait(
      until.elementLocated(By.xpath('//div[contains(text(), "Status")]')),
      30000
    )

    console.log("-> Extension loaded!")

    // if there is a page with a button "I got it", click it
    try {
      const gotItButton = await driver.findElement(
        By.xpath('//button[contains(text(), "I got it")]')
      )
      await gotItButton.click()
      console.log('-> "I got it" button clicked!')
    } catch (error) {
      // save rendered dom to file
      const dom = await driver
        .findElement(By.css("html"))
        .getAttribute("outerHTML")
      fs.writeFileSync("dom.html", dom)
      console.error('-> No "I got it" button found!(skip)')
    }

    // if found a div include text "Sorry, Gradient is not yet available in your region. ", then exit
    try {
      await driver.findElement(
        By.xpath(
          '//*[contains(text(), "Sorry, Gradient is not yet available in your region.")]'
        )
      )
      console.log("-> Sorry, Gradient is not yet available in your region. ")
      await driver.quit()
      process.exit(1)
    } catch (error) {
      console.log("-> Gradient is available in your region. ")
    }

    // <div class="absolute mt-3 right-0 z-10">
    const supportStatus = await driver
      .findElement(By.css(".absolute.mt-3.right-0.z-10"))
      .getText()


    if (ALLOW_DEBUG) {
      const dom = await driver
        .findElement(By.css("html"))
        .getAttribute("outerHTML")
      fs.writeFileSync("dom.html", dom)
      await takeScreenshot(driver, "status.png")
    }

    console.log("-> Status:", supportStatus)

    if (supportStatus.includes("Disconnected")) {
      console.log(
        "-> Failed to connect! Please check the following: ",
      )
      console.log(`
    - Make sure the proxy is working, by 'curl -vv -x ${PROXY} https://myip.ipip.net'
    - Make sure the docker image is up to date, by 'docker pull overtrue/gradient-bot' and re-start the container.
    - The official service itself is not very stable. So it is normal to see abnormal situations. Just wait patiently and it will restart automatically.
    - If you are using a free proxy, it may be banned by the official service. Please try another static Static Residential proxy.
  `)
      await generateErrorReport(driver)
      await driver.quit()
      setTimeout(() => {
        process.exit(1)
      }, 5000)
    }

    console.log("-> Connected! Starting rolling...")

    // 截图链接状态
    takeScreenshot(driver, "connected.png")

    console.log({
      support_status: supportStatus,
    })

    console.log("-> Lunched!")

    // keep the process running with better error handling
    let intervalId = setInterval(async () => {
      try {
        // 检查driver是否还有效
        const title = await driver.getTitle()
        console.log(`-> [${USER}] Running...`, title)

        if (PROXY) {
          console.log(`-> [${USER}] Running with proxy ${PROXY}...`)
        } else {
          console.log(`-> [${USER}] Running without proxy...`)
        }

        // 定期模拟人类行为，避免检测
        if (Math.random() < 0.3) { // 30%概率执行
          await antiDetectionSystem.simulateHumanBehavior(driver)
        }

      } catch (error) {
        console.error("-> Error in monitoring loop:", error.message)
        // 如果driver出错，清理定时器并退出
        clearInterval(intervalId)
        console.log("-> Stopping monitoring due to driver error")
        try {
          await driver.quit()
          await resourceManager.cleanup()
        } catch (quitError) {
          console.error("-> Error during cleanup:", quitError.message)
        }
        process.exit(1)
      }
    }, 30000)

    // 添加进程退出时的清理
    process.on('SIGINT', async () => {
      console.log('-> Received SIGINT, cleaning up...')
      clearInterval(intervalId)
      try {
        await driver.quit()
        await resourceManager.cleanup()
      } catch (error) {
        console.error('-> Error during cleanup:', error.message)
      }
      process.exit(0)
    })

    process.on('SIGTERM', async () => {
      console.log('-> Received SIGTERM, cleaning up...')
      clearInterval(intervalId)
      try {
        await driver.quit()
        await resourceManager.cleanup()
      } catch (error) {
        console.error('-> Error during cleanup:', error.message)
      }
      process.exit(0)
    })
  } catch (error) {
    console.error("Error occurred:", error)
    // show error line
    console.error(error.stack)

    if (driver) {
      try {
        await generateErrorReport(driver)
        console.error("-> Error report generated!")
        console.error(fs.readFileSync("error.log").toString())
        await driver.quit()
      } catch (reportError) {
        console.error("-> Error generating report:", reportError.message)
      }
    }

    // 清理资源
    try {
      await resourceManager.cleanup()
    } catch (cleanupError) {
      console.error("-> Cleanup error:", cleanupError.message)
    }

    process.exit(1)
  }
  } catch (globalError) {
    console.error("-> Global error occurred:", globalError)
    console.error(globalError.stack)

    // 清理资源
    try {
      await resourceManager.cleanup()
    } catch (cleanupError) {
      console.error("-> Cleanup error:", cleanupError.message)
    }

    process.exit(1)
  }
})()
