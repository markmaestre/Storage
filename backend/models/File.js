const mongoose = require('mongoose');

const fileSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  originalName: {
    type: String,
    required: function() {
      return !this.isFolder; // Only required for files, not folders
    }
  },
  type: {
    type: String,
    required: true,
    enum: ['document', 'image', 'video', 'audio', 'pdf', 'spreadsheet', 'presentation', 'archive', 'text', 'code', 'folder']
  },
  size: {
    type: Number,
    required: true,
    default: 0
  },
  path: {
    type: String,
    required: function() {
      return !this.isFolder && this.type !== 'document' && this.type !== 'spreadsheet' && this.type !== 'presentation';
    }
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  parentFolder: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'File',
    default: null
  },
  isFolder: {
    type: Boolean,
    default: false
  },
  // Content for documents (Google Docs, Sheets, Slides)
  content: {
    type: String,
    default: ''
  },
  // Document-specific metadata
  documentMetadata: {
    wordCount: { type: Number, default: 0 },
    pageCount: { type: Number, default: 0 },
    lastModifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    versionHistory: [{
      version: Number,
      content: String,
      modifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      modifiedAt: { type: Date, default: Date.now },
      changes: String
    }]
  },
  sharedWith: [{
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    permission: {
      type: String,
      enum: ['view', 'edit'],
      default: 'view'
    },
    sharedAt: {
      type: Date,
      default: Date.now
    }
  }],
  isPublic: {
    type: Boolean,
    default: false
  },
  publicUrl: {
    type: String
  },
  inTrash: {
    type: Boolean,
    default: false
  },
  deletedAt: {
    type: Date
  },
  permanentDeleteAt: {
    type: Date
  },
  version: {
    type: Number,
    default: 1
  },
  tags: [String],
  metadata: {
    type: Map,
    of: String
  }
}, {
  timestamps: true
});

// Index for better query performance
fileSchema.index({ userId: 1, parentFolder: 1 });
fileSchema.index({ userId: 1, inTrash: 1 });
fileSchema.index({ 'sharedWith.user': 1 });
fileSchema.index({ permanentDeleteAt: 1 }, { expireAfterSeconds: 0 });
fileSchema.index({ isFolder: 1 });
fileSchema.index({ type: 1 });

// Virtual for file URL
fileSchema.virtual('url').get(function() {
  if (this.isFolder) {
    return null; // Folders don't have download URLs
  }
  return `/api/files/${this._id}/download`;
});

// Virtual for document edit URL
fileSchema.virtual('editUrl').get(function() {
  if (['document', 'spreadsheet', 'presentation'].includes(this.type)) {
    return `/editor/${this._id}`;
  }
  return null;
});

// Method to check if file is shared with user
fileSchema.methods.isSharedWith = function(userId) {
  return this.sharedWith.some(share => share.user.toString() === userId.toString());
};

// Method to get share permissions for user
fileSchema.methods.getUserPermissions = function(userId) {
  const share = this.sharedWith.find(share => share.user.toString() === userId.toString());
  return share ? share.permission : null;
};

// Method to check if item can be edited
fileSchema.methods.canEdit = function(userId) {
  if (this.userId.toString() === userId.toString()) {
    return true;
  }
  
  const share = this.sharedWith.find(share => share.user.toString() === userId.toString());
  return share && share.permission === 'edit';
};

// Method to add version history
fileSchema.methods.addVersion = function(content, modifiedBy, changes = '') {
  if (['document', 'spreadsheet', 'presentation'].includes(this.type)) {
    this.documentMetadata.versionHistory.push({
      version: this.version,
      content: content,
      modifiedBy: modifiedBy,
      changes: changes
    });
    this.version += 1;
  }
};

// Static method to get folder contents
fileSchema.statics.getFolderContents = async function(folderId, userId) {
  return this.find({
    parentFolder: folderId,
    userId: userId,
    inTrash: false
  }).sort({ isFolder: -1, name: 1 }); // Folders first, then files
};

// Static method to calculate folder size recursively
fileSchema.statics.calculateFolderSize = async function(folderId) {
  const files = await this.find({ parentFolder: folderId, isFolder: false });
  return files.reduce((total, file) => total + file.size, 0);
};

// Pre-save middleware to handle folder-specific logic
fileSchema.pre('save', function(next) {
  // Set type to 'folder' if isFolder is true
  if (this.isFolder) {
    this.type = 'folder';
    this.size = 0;
    this.path = null;
    this.originalName = this.name; // Set originalName to name for folders
  }
  
  // Calculate word count for documents
  if (this.content && ['document', 'spreadsheet', 'presentation'].includes(this.type)) {
    this.documentMetadata.wordCount = this.content.split(/\s+/).length;
  }
  
  next();
});

// Pre-remove middleware to handle folder deletion
fileSchema.pre('remove', async function(next) {
  if (this.isFolder) {
    // Delete all files in this folder
    const folderContents = await this.model('File').find({ parentFolder: this._id });
    for (const file of folderContents) {
      await file.remove();
    }
  }
  
  // Delete physical file if it exists
  if (this.path && require('fs').existsSync(this.path)) {
    require('fs').unlinkSync(this.path);
  }
  
  next();
});

module.exports = mongoose.models.File || mongoose.model('File', fileSchema);