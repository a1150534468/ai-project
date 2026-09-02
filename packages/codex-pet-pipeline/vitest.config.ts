import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 这个包的用例是真的在跑像素处理（抠色、连通域、图集拼装），单个用例几百毫秒到一秒多，
    // vitest 默认的 5000ms 在 GitHub 的 2 核 runner 上不够用：本机 551ms / 609ms 的两个用例，
    // 在 runner 上是 5026ms / 5009ms —— 同一份确定性输入，只是机器慢 5~9 倍，于是卡在默认超时上
    // 变成随机红（run 33628418352）。
    //
    // 30s 是按「最慢的用例本机 1.5s × runner 的 9 倍 × 2 倍余量」定的。刻意不设成更大：
    // 真挂住的用例还是要被拦下来，这个包整个文件在 runner 上也只跑 52s。
    //
    // 为什么是包级而不是给那两个用例加第三个参数：同文件里还有好几个用例在 runner 上是
    // 3~4s（direction-registration.test.ts 有一个 3840ms），只按今天红的那两个打补丁，
    // 下次换一台更忙的 runner 就换成另外两个红。
    testTimeout: 30000,
  },
});
