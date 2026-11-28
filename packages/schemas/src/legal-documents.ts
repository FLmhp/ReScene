export type LegalDocumentId = "terms" | "privacy" | "licenses";

type LegalDocument = {
  id: LegalDocumentId;
  title: string;
  status: "审核稿 · 尚未生效" | null;
  paragraphs: readonly string[];
};

export const legalDocuments: readonly LegalDocument[] = [
  {
    id: "terms",
    title: "用户协议",
    status: "审核稿 · 尚未生效",
    paragraphs: [
      "账户。请妥善保管账户凭据。账户仅供授权人员使用，发现异常登录时请及时更改密码。",
      "上传素材。请只上传你有权使用和处理的图片、视频及其他素材；涉及他人的内容时，请先取得必要授权。",
      "项目权限。项目所有者可以管理成员和权限。成员可以执行的操作由其项目角色决定；请勿绕过权限或尝试访问未授权的项目。",
      "分享。发布成果链接前，请确认有权分享相应内容。获得链接的人可能继续转发；撤回链接不会删除他人已经保存的副本。",
      "禁止滥用。请勿利用服务侵害他人权利、干扰服务、恶意消耗资源，或上传和分享违法内容。",
    ],
  },
  {
    id: "privacy",
    title: "隐私说明",
    status: "审核稿 · 尚未生效",
    paragraphs: [
      "账户资料。邮箱用于识别账户和发送验证码；用户名可用于登录和显示。设置头像后，服务保存处理后的头像缩略图。可在「设置 → 账户与安全」移除头像。",
      "项目数据。上传的图片、视频等素材存放在私有对象存储（OSS），供获授权的项目访问和重建使用。服务保存重建任务状态、运行日志及操作审计记录，用于显示任务进度、排查问题和管理权限。对外分享时，请先确认链接的访问范围。",
      "设备偏好。主题、配色、字体和面板效果保存在当前设备，不同步到账户。账户资料和邮件订阅设置随账户同步。",
      "邮件通知。开启任一邮件订阅前需要验证账户邮箱。服务通过 SMTP 向该邮箱发送你订阅的重要公告或任务结果，SMTP 投递状态与站内已读状态分开记录。可在「设置 → 通知偏好」关闭任一订阅；关闭订阅不会清除站内消息或已投递邮件。",
    ],
  },
  {
    id: "licenses",
    title: "开源许可",
    status: null,
    paragraphs: [
      "下列为 ReScene 仓库的 MIT 许可与 Inter 字体的署名和许可，不是全部第三方软件的清单。",
      // Snapshots of LICENSE and packages/design-tokens/assets/Inter-LICENSE.txt.
      `MIT License

Copyright (c) 2026 ReScene contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the
following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial
portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
USE OR OTHER DEALINGS IN THE SOFTWARE.
`,
      `Copyright (c) 2016 The Inter Project Authors (https://github.com/rsms/inter)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL

-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION AND CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
`,
    ],
  },
];
