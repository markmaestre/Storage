const mongoose = require('mongoose');

const storageStatsSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true
  },
  totalFiles: {
    type: Number,
    default: 0
  },
  totalFolders: {
    type: Number,
    default: 0
  },
  totalSize: {
    type: Number,
    default: 0
  },
  usedStorage: {
    type: Number,
    default: 0
  },
  fileTypeBreakdown: {
    document: { type: Number, default: 0 },
    image: { type: Number, default: 0 },
    video: { type: Number, default: 0 },
    audio: { type: Number, default: 0 },
    pdf: { type: Number, default: 0 },
    spreadsheet: { type: Number, default: 0 },
    presentation: { type: Number, default: 0 },
    archive: { type: Number, default: 0 },
    text: { type: Number, default: 0 },
    code: { type: Number, default: 0 }
  },
  lastCalculated: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Index
storageStatsSchema.index({ userId: 1 });

// Method to update stats
storageStatsSchema.statics.updateUserStats = async function(userId) {
  try {
    const File = mongoose.model('File');
    
    const fileStats = await File.aggregate([
      { $match: { userId: mongoose.Types.ObjectId(userId), inTrash: false } },
      {
        $group: {
          _id: '$type',
          count: { $sum: 1 },
          totalSize: { $sum: '$size' }
        }
      }
    ]);

    const folderStats = await File.aggregate([
      { $match: { userId: mongoose.Types.ObjectId(userId), isFolder: true, inTrash: false } },
      { $count: 'count' }
    ]);

    const totalStats = await File.aggregate([
      { $match: { userId: mongoose.Types.ObjectId(userId), inTrash: false } },
      {
        $group: {
          _id: null,
          totalFiles: { $sum: { $cond: [{ $eq: ['$isFolder', false] }, 1, 0] } },
          totalSize: { $sum: '$size' }
        }
      }
    ]);

    const fileTypeBreakdown = {};
    let totalSize = 0;
    let totalFiles = 0;

    fileStats.forEach(stat => {
      fileTypeBreakdown[stat._id] = stat.count;
      totalSize += stat.totalSize;
      totalFiles += stat.count;
    });

    const totalFolders = folderStats[0]?.count || 0;

    await this.findOneAndUpdate(
      { userId },
      {
        totalFiles,
        totalFolders,
        totalSize,
        usedStorage: totalSize,
        fileTypeBreakdown,
        lastCalculated: new Date()
      },
      { upsert: true, new: true }
    );

    return { totalFiles, totalFolders, totalSize, fileTypeBreakdown };
  } catch (error) {
    console.error('Error updating storage stats:', error);
    throw error;
  }
};

module.exports = mongoose.models.StorageStats || mongoose.model('StorageStats', storageStatsSchema);